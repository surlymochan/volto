# Bot host policy

This document describes the host policy for bot kinds.
A host is either the special value `local` or a remote SSH alias.
The kind determines which of these forms is accepted.

## Kind and host matrix

| kind | local | remote |
| --- | --- | --- |
| claude | allowed | rejected |
| codex | rejected | allowed |
| pi | rejected | allowed |
| agy | rejected | allowed |
| dsh | rejected | allowed |
| other | rejected | allowed |

`claude` runs only on `local`; remote hosts are never accepted for it.
Every other kind uses a remote SSH alias and never `local`.
The `other` row applies to kinds not listed separately in the matrix.

## Remote aliases

A remote host must be an SSH alias, not the special value `local`.
Alias characters are limited to `[A-Za-z0-9_.-]`.
Use an alias configured for SSH when selecting a remote host.
The alias is a host selector, not a command or a connection string.

## Defaults and errors

No non-`claude` kind has `local` as its default host.
A host selection that violates this policy is rejected with error code
`HOST_POLICY`.
Correct the kind or host selection before retrying the request.
