# VS Code QuakeC Extension

A Visual Studio Code extension for the QuakeC language, including IntelliSense, diagnostics, and code navigation. It understands the modern QuakeC accepted by [gmqcc](https://github.com/graphitemaster/gmqcc), as well as original QuakeC.

## Features
- **Diagnostics**: syntax errors as you type, checked against the same grammar gmqcc uses.
- **Hover**: the type of any variable, field, function, or parameter, plus the value of constants, enum members, frames, and macros.
- **Go to Definition** and **Find All References**, across every file in `progs.src`. A function's prototype and body count as the same symbol.
- **Syntax highlighting** for QuakeC, including gmqcc keywords, attributes, preprocessor directives, and `$frame` commands.
- Supports `.qc` and `.qh` files.

## Language support
The `quakec.language` setting matches gmqcc's `-std` option:

| Setting | Use it for |
| --- | --- |
| `gmqcc` (default) | `gmqcc -std=gmqcc` |
| `fteqcc` | `gmqcc -std=fteqcc` |
| `qcc` | `gmqcc -std=qcc`, or original QuakeC |

With `gmqcc` and `fteqcc`, the extension understands:
- `const`, `var`, `noref`, `local`, and `static` qualifiers
- C-style function declarations: `float add(float a, float b) { ... }`
- `for`, `switch`/`case`/`default`, `break`, `continue`, `goto` and `:labels`, `if not`, loop labels
- Arrays, including field arrays and array initializers
- `typedef`, `enum`, `enum : flag`, and `enum : reverse`
- Variadic functions (`...`, `float... count`, `...(i, float)`)
- Attributes such as `[[noreturn]]`, `[[accumulate]]`, `[[deprecated("...")]]`, and `[[last]]`
- The full gmqcc operator set: `++`, `--`, `%`, `^`, `~`, `<<`, `>>`, `**`, `><`, `<=>`, `?:`, and compound assignments
- `int`, `nil`, `__FUNC__`, hex numbers, character constants, and joined string literals
- The preprocessor: `#define` (including function-like macros), `#undef`, `#if`/`#ifdef`/`#elif`/`#else`/`#endif`, `#include`, `#error`, and `#warning`. Macros defined in one file are visible in the files after it in `progs.src`, as they are for the compiler. Code in inactive `#if` blocks is faded out.

With `qcc`, gmqcc-only syntax such as C-style functions and newer operators is reported as an error.

Note that gmqcc only runs its preprocessor with `-std=fteqcc` or `-fftepp`. The extension always accepts preprocessor directives, since it can't see your build flags.

### What is not checked
The extension checks syntax and declarations, not types. Errors such as passing the wrong type to a function, or using an undefined name, are still left to the compiler.

## Project layout
The extension reads `progs.src` to learn the order your files compile in, which is how it finds definitions from earlier files. Both the classic format (output file on the first line, then one source file per line) and FTEQCC's `#includelist` blocks are supported. Files not listed in `progs.src` are still checked on their own.

## Development
- `npm install` installs dependencies for the client, server, and parser.
- `npx mocha parser/test` runs the parser tests.
- Press F5 in VS Code to launch an Extension Development Host.

## Questions, issues, feature requests, and contributions
- If you come across a problem with the extension, please [file an issue](https://github.com/joshuaskelly/vscode-quakec).
- Contributions are always welcome!
- Any and all feedback is appreciated and welcome!
- If someone has already filed an issue that encompasses your feedback, please leave a 👍/👎 reaction on the issue
