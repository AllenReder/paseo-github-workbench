# Security policy

## Supported versions

Security fixes are applied to the latest version on the main branch.

## Reporting a vulnerability

Please do not disclose vulnerabilities, credentials, private repository
contents, or local filesystem paths in a public issue. A private reporting
channel is not currently available; contact the repository maintainer before
publishing sensitive details.

## Trust boundary

Paseo plugins are trusted code. This plugin invokes the locally authenticated
gh and git executables from the Paseo daemon host. Install it only from a
source you trust and review updates before applying them.
