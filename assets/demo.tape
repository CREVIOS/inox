Output assets/inox-demo.gif

Set Shell "bash"
Set FontSize 19
Set Width 1180
Set Height 700
Set Padding 22
Set Theme "Catppuccin Latte"
Set TypingSpeed 45ms

Hide
Type "cd /tmp/inox-demo && clear" Enter
Show

Sleep 600ms
Type "# one spec, every SDK" Enter
Sleep 800ms
Type "inox init --force" Enter
Sleep 1500ms
Type "inox generate --out sdk" Enter
Sleep 3s
Type "ls sdk" Enter
Sleep 1800ms
Type "tail -2 sdk/typescript/README.md" Enter
Sleep 2600ms
