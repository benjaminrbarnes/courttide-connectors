# Package releases

The package uses tags in the form `connectors-vX.Y.Z`. Each published GitHub
Release contains the compiled npm tarball, `SHA256SUMS.txt` and `INTEGRITY.txt`
with its npm `sha512-...` integrity string. The release workflow runs the full
check, scans the exact tarball, then installs it in an empty Node 24 project and
checks both platform imports and the CLI. The tagged commit must be on `main`.
The archive check also rejects duplicate paths, unsafe paths, opaque binary
content and non-regular entries such as symbolic links. The package contains
compiled text, declarations and its JSON schema.

Before tagging, finish review and merge the intended package, CLI and contributor
guides. Update the package version, lockfile and versioned section in
[CHANGELOG.md](../CHANGELOG.md), and run `npm run check`. Confirm immutable
releases are enabled in repository settings using an account that can read that
setting. The ordinary workflow token cannot read repository administration
settings; it does not need an administration secret.

Create the tag once on the accepted `main` commit and push it. The workflow
requires the tag to match the package version and refuses lifecycle install
scripts. It attaches every asset before publishing the release and checks that
the resulting release is immutable. Never move a release tag, replace an asset
or reuse a published version. If a published release needs correction, release a
new patch version.

After the workflow completes, download the tarball and verify the release and
asset using GitHub CLI:

```sh
gh release verify connectors-vX.Y.Z
gh release verify-asset connectors-vX.Y.Z ./courttide-connectors-X.Y.Z.tgz
```

The checksum and integrity files also let consumers verify the downloaded bytes.
If a release fails before publication, inspect the workflow and draft state
before taking any recovery action. Do not overwrite a published asset or retag.

When the repository has an `NPM_TOKEN` secret, the workflow additionally runs
`npm publish --provenance --access public` with that token in the process
environment. Without the secret, it skips npm and the immutable GitHub Release
remains the distribution source. Configure or rotate secrets in GitHub's
supported settings; never put a token in a file, command argument or log.
