# Security Policy

## Reporting a vulnerability

Do not post credentials, private keys, exploit details, or other sensitive material in a public issue.

For sensitive reports, prefer GitHub private vulnerability reporting / a private Security Advisory when it is enabled for this repository. If private reporting is not available, open a minimal non-sensitive issue asking for a private reporting channel without including exploit details or secrets.

For ordinary bugs that do not expose sensitive information, use the public issue tracker.

## Release security

Published npm releases are expected to be produced only from the repository's verified release pipeline. The pipeline is designed to fail closed on unexpected package contents, sensitive-data findings, untrusted release sources, version/tag mismatches, or missing lockfile state.

A suspected compromised release, leaked credential, or unexpected npm publication should be reported as a security issue rather than a normal bug.
