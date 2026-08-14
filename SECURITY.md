# Security policy

## Supported versions

Security fixes are applied to the latest released version and the `main` branch.

## Reporting a vulnerability

Do not open a public issue for path traversal, arbitrary file copy/overwrite, command injection, unsafe firmware programming, secret exposure, or MCP boundary vulnerabilities.

Use GitHub private vulnerability reporting for `IZJXXXX/dockyard32`. Include:

- affected version or commit;
- platform and project format;
- minimal reproduction without private source code;
- impact and files/devices affected;
- suggested mitigation, if known.

You should receive an acknowledgement within seven days. Please allow time for a fix and coordinated disclosure.

## Security boundaries

- Core conversion inputs are untrusted.
- The extension invokes fixed tool operations and does not expose an arbitrary shell.
- The local MCP server uses stdio and an explicit workspace path; it does not open a network listener.
- Flash/reset actions affect physical hardware and require the normal Dockyard32 operation checks.
- Conversion does not establish source-code or binary equivalence between GCC, ARM Compiler 5, and ARM Compiler 6.
