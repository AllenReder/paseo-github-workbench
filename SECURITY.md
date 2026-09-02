# Security policy

## Supported versions

Security fixes are applied to the latest version on the main branch.

## Reporting a vulnerability

Please do not disclose vulnerabilities, credentials, private repository
contents, or local filesystem paths in a public issue. Use GitHub's private
vulnerability-reporting flow for this repository when available:

https://github.com/AllenReder/paseo-github-workbench/security/advisories/new

If that flow is unavailable, contact the repository maintainer through GitHub
before publishing details.

## Trust boundary

Paseo plugins are trusted code. This plugin invokes the locally authenticated
gh and git executables from the Paseo daemon host. Install it only from a
source you trust and review updates before applying them.
