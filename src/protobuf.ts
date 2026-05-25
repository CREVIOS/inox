// Real protobuf binary wire framing (zero dependency), driven directly by the IR — the
// codec the Connect client uses for `application/proto` instead of Connect-JSON. Implements
// the protobuf wire format (https://protobuf.dev/programming-guides/encoding/): base-128
// varints, length-delimited fields, fixed64 doubles. Field numbers are assigned by field
// order (1-based), so the same IR drives both ends. No .proto file or external runtime.
import type { ApiIR, ObjectTypeIR, TypeRefIR } from "./types.js";

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LEN = 2;

function typeById(ir: ApiIR, id: string) {
  return ir.types.find((type) => type.id === id);
}

// ---------- low-level writers ----------

class Writer {
  bytes: number[] = [];
  varint(value: number): void {
    let v = value >>> 0 === value ? value : Math.trunc(value);
    if (v < 0) v = v >>> 0; // treat small negatives as unsigned for our scalar set
    while (v > 0x7f) {
      this.bytes.push((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    this.bytes.push(v & 0x7f);
  }
  tag(field: number, wire: number): void {
    this.varint((field << 3) | wire);
  }
  lenDelim(field: number, payload: number[]): void {
    this.tag(field, WIRE_LEN);
    this.varint(payload.length);
    for (const b of payload) this.bytes.push(b);
  }
  fixed64(field: number, value: number): void {
    this.tag(field, WIRE_FIXED64);
    const buffer = new ArrayBuffer(8);
    new DataView(buffer).setFloat64(0, value, true);
    for (const b of new Uint8Array(buffer)) this.bytes.push(b);
  }
  string(field: number, value: string): void {
    this.lenDelim(field, [...new TextEncoder().encode(value)]);
  }
}

// ---------- reader ----------

class Reader {
  pos = 0;
  constructor(private readonly buf: Uint8Array) {}
  get done(): boolean {
    return this.pos >= this.buf.length;
  }
  varint(): number {
    let result = 0;
    let shift = 0;
    while (true) {
      const byte = this.buf[this.pos++]!;
      result += (byte & 0x7f) * Math.pow(2, shift);
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return result;
  }
  fixed64(): number {
    const view = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8);
    this.pos += 8;
    return view.getFloat64(0, true);
  }
  bytes(): Uint8Array {
    const length = this.varint();
    const slice = this.buf.subarray(this.pos, this.pos + length);
    this.pos += length;
    return slice;
  }
}

// ---------- IR-driven encode ----------

function scalarWire(ir: ApiIR, ref: TypeRefIR): number {
  if (ref.kind === "primitive") return ref.name === "string" ? WIRE_LEN : ref.name === "number" ? WIRE_FIXED64 : WIRE_VARINT;
  if (ref.kind === "ref") {
    const type = typeById(ir, ref.id);
    if (type?.kind === "enum") return type.value_type === "integer" ? WIRE_VARINT : WIRE_LEN;
    return WIRE_LEN; // embedded message / alias-to-object
  }
  return WIRE_LEN;
}

function encodeField(ir: ApiIR, writer: Writer, field: number, ref: TypeRefIR, value: unknown): void {
  if (value === null || value === undefined) return;
  switch (ref.kind) {
    case "primitive":
      if (ref.name === "string") writer.string(field, String(value));
      else if (ref.name === "number") writer.fixed64(field, Number(value));
      else if (ref.name === "boolean") {
        writer.tag(field, WIRE_VARINT);
        writer.varint(value ? 1 : 0);
      } else {
        writer.tag(field, WIRE_VARINT);
        writer.varint(Number(value));
      }
      return;
    case "array":
      for (const item of value as unknown[]) encodeField(ir, writer, field, ref.items, item);
      return;
    case "map": {
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        const entry = new Writer();
        entry.string(1, key);
        encodeField(ir, entry, 2, ref.values, val);
        writer.lenDelim(field, entry.bytes);
      }
      return;
    }
    case "file":
      writer.lenDelim(field, [...(value as Uint8Array)]);
      return;
    case "ref": {
      const type = typeById(ir, ref.id);
      if (!type) return;
      if (type.kind === "object") writer.lenDelim(field, encodeObject(ir, type, value as Record<string, unknown>).bytes);
      else if (type.kind === "enum") {
        if (type.value_type === "integer") {
          writer.tag(field, WIRE_VARINT);
          writer.varint(Number(value));
        } else writer.string(field, String(value));
      } else if (type.kind === "alias") encodeField(ir, writer, field, type.target, value);
      else writer.lenDelim(field, encodeUnknown(value));
      return;
    }
    default:
      return;
  }
}

function encodeObject(ir: ApiIR, type: ObjectTypeIR, value: Record<string, unknown>): Writer {
  const writer = new Writer();
  type.fields.forEach((field, index) => {
    encodeField(ir, writer, index + 1, field.type, value[field.wire_name]);
  });
  return writer;
}

function encodeUnknown(value: unknown): number[] {
  return [...new TextEncoder().encode(JSON.stringify(value))];
}

/** Encodes a JSON value of the given IR object type into protobuf wire bytes. */
export function encodeMessage(ir: ApiIR, typeId: string, value: Record<string, unknown>): Uint8Array {
  const type = typeById(ir, typeId);
  if (!type || type.kind !== "object") return new Uint8Array(encodeUnknown(value));
  return new Uint8Array(encodeObject(ir, type, value).bytes);
}

// ---------- IR-driven decode ----------

function decodeField(ir: ApiIR, reader: Reader, wire: number, ref: TypeRefIR): unknown {
  switch (ref.kind) {
    case "primitive":
      if (ref.name === "string") return new TextDecoder().decode(reader.bytes());
      if (ref.name === "number") return reader.fixed64();
      if (ref.name === "boolean") return reader.varint() !== 0;
      return reader.varint();
    case "array":
      return decodeField(ir, reader, wire, ref.items); // collected by caller
    case "map": {
      const entry = new Reader(reader.bytes());
      let key = "";
      let val: unknown;
      while (!entry.done) {
        const tag = entry.varint();
        const fieldNo = tag >> 3;
        const entryWire = tag & 7;
        if (fieldNo === 1) key = new TextDecoder().decode(entry.bytes());
        else val = decodeScalarByWire(ir, entry, entryWire, (ref.values as TypeRefIR));
      }
      return { __mapEntry: true, key, val };
    }
    case "file":
      return reader.bytes();
    case "ref": {
      const type = typeById(ir, ref.id);
      if (!type) return reader.bytes();
      if (type.kind === "object") return decodeObject(ir, type, reader.bytes());
      if (type.kind === "enum") return type.value_type === "integer" ? reader.varint() : new TextDecoder().decode(reader.bytes());
      if (type.kind === "alias") return decodeField(ir, reader, wire, type.target);
      return JSON.parse(new TextDecoder().decode(reader.bytes())) as unknown;
    }
    default:
      return reader.bytes();
  }
}

function decodeScalarByWire(ir: ApiIR, reader: Reader, wire: number, ref: TypeRefIR): unknown {
  if (wire === WIRE_LEN) return decodeField(ir, reader, wire, ref);
  if (wire === WIRE_FIXED64) return reader.fixed64();
  return reader.varint();
}

function decodeObject(ir: ApiIR, type: ObjectTypeIR, bytes: Uint8Array): Record<string, unknown> {
  const reader = new Reader(bytes);
  const out: Record<string, unknown> = {};
  while (!reader.done) {
    const tag = reader.varint();
    const fieldNo = tag >> 3;
    const wire = tag & 7;
    const field = type.fields[fieldNo - 1];
    if (!field) {
      // unknown field: skip by wire type
      if (wire === WIRE_LEN) reader.bytes();
      else if (wire === WIRE_FIXED64) reader.fixed64();
      else reader.varint();
      continue;
    }
    if (field.type.kind === "array") {
      const item = decodeField(ir, reader, wire, field.type.items);
      const list = (out[field.wire_name] as unknown[]) ?? [];
      list.push(item);
      out[field.wire_name] = list;
    } else if (field.type.kind === "map") {
      const entry = decodeField(ir, reader, wire, field.type) as { key: string; val: unknown };
      const obj = (out[field.wire_name] as Record<string, unknown>) ?? {};
      obj[entry.key] = entry.val;
      out[field.wire_name] = obj;
    } else {
      out[field.wire_name] = decodeField(ir, reader, wire, field.type);
    }
  }
  return out;
}

/** Decodes protobuf wire bytes of the given IR object type back into a JSON value. */
export function decodeMessage(ir: ApiIR, typeId: string, bytes: Uint8Array): unknown {
  const type = typeById(ir, typeId);
  if (!type || type.kind !== "object") return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  return decodeObject(ir, type, bytes);
}
