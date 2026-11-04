# Changelog

## 0.3.0
- First release as QuakeC Modern, a fork of [vscode-quakec](https://github.com/joshuaskelly/vscode-quakec) by Joshua Skelton.
- New parser that follows gmqcc's grammar. Code that gmqcc compiles no longer shows false errors.
- Added support for `const`, `var`, `noref`, C-style functions, `for`, `switch`, `goto`, `typedef`, `enum`, arrays, attributes, variadic functions, and the full gmqcc operator set.
- Added a preprocessor: macros, conditional compilation, `#include`, `#error`, and `#warning`. Inactive `#if` blocks are faded out.
- The `quakec.language` setting now matches gmqcc's `-std` option (`gmqcc`, `fteqcc`, or `qcc`) and defaults to `gmqcc`.
- Hover shows the values of constants, enum members, frames, and macros.
- Find All References links a function's prototype and body, even across files.
- New syntax highlighting grammar with gmqcc keywords, attributes, and preprocessor directives.
- Added `.qh` files, and support for FTEQCC-style `progs.src` files.
- Files changed outside the editor, such as by a `git checkout`, are reloaded.
- Fixed: paths containing spaces or other special characters.
- Fixed: comment toggling and bracket matching, whose configuration file was not being found.
