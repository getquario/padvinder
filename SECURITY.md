# Security Policy

## Security considerations

Do not treat padvinder as a sandbox or access-control layer. It parses queries into closures and generates no JavaScript source. It ignores inherited properties and blocks `__proto__`, `constructor`, and `prototype`. These constraints make padvinder CSP-safe, but they do not decide which data a query may read.

Anyone who controls a query can select data reachable from the document you provide. Results contain references to matched objects and arrays, not copies. Keep secrets and privileged objects out of the document.

Custom filter functions run in the current process and receive values from the document. They may perform I/O, change application state, expose more data, or consume excessive CPU. Only register functions you trust.

The built-in `match()` and `search()` functions use a bounded I-Regexp matcher. Other query operations can still inspect or return many nodes when the input document is large.

Before you accept untrusted queries:

- Build a document containing only the data the query may read.
- Register pure functions with no access to privileged APIs such as the network, filesystem, or processes.
- Pass a copy of the document, or freeze its whole object graph, if callers or custom functions must not change application state.
- Set limits for query length, document size, and result count. For an execution deadline, use a worker or separate process that you can terminate.

Treat queries as code. Keep user input out of query syntax when a fixed query with data values will do.

## Reporting a vulnerability

Do not open a public GitHub issue for a security vulnerability.

Use [GitHub's private vulnerability form](https://github.com/robinvdvleuten/padvinder/security/advisories/new).

Include the affected code, its impact, and steps that reproduce the issue. Tell us whether and how to credit you.

We do not accept AI slop reports.

Keep the report private while we investigate and prepare a fix.
