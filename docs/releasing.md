# Publishing lmspeed-audit

Stable `vX.Y.Z` tags run `.github/workflows/release.yml`. The tag must match `package.json` and `ENGINE_VERSION`. The workflow verifies the package, installs its tarball in a clean consumer, and checks the portable command on Linux, macOS and Windows with Node.js 22 and 24 before publishing downloads. Releases are immutable; retries reuse their original files.

When no bootstrap token is configured, the npm job verifies the GitHub-to-npm OIDC exchange even when the version already exists. This checks that the trusted publisher is still usable without creating another public version. Exchanged credentials are never printed or persisted.

## Registries

- npm: [`@lmspeed/audit`](https://www.npmjs.com/package/@lmspeed/audit), public, with provenance. For the first publication, configure repository secret `NPM_TOKEN` with permission to publish this package under the `@lmspeed` scope. After the package exists, configure an [npm trusted publisher](https://docs.npmjs.com/trusted-publishers/): user `nexmoe`, repository `lmspeed-audit`, workflow `release.yml`, no environment. Once verified, remove the token secret; the workflow has `id-token: write` for OIDC. Publishing uses the npm CLI provided by Node.js 24 through `pnpm publish` (npm >=11.5.1 is required).
- GitHub Packages: [`@nexmoe/lmspeed-audit`](https://github.com/nexmoe/lmspeed-audit/packages), using this repository's `GITHUB_TOKEN`. GitHub requires the package scope to match the repository owner. The SDK can be installed under its usual name with a package alias. GitHub initially creates packages as private: after the first publication, change package settings to **Public**. Even public npm packages on GitHub require a `read:packages` token for installation. See [GitHub's registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry).

## Homebrew, Scoop and downloads

The repository doubles as a Homebrew tap (`Formula/`) and Scoop bucket (`bucket/`). After a release, the workflow commits the exact generated manifests to `main`. Both point to versioned release archives with SHA-256 checksums. Portable archives bundle the runtime dependencies and all license notices; they need Node.js >=22.12 but do not download code during installation. Homebrew installs Node.js automatically; Scoop depends on `nodejs-lts`. This is an upstream-maintained tap and bucket; it does not claim inclusion in Homebrew/core, Scoop main, winget or Chocolatey.

```sh
pnpm check
pnpm release:prepare
pnpm release:smoke
git tag vX.Y.Z
git push origin main vX.Y.Z
```

Update both changelogs before tagging. To retry registry publication or installer updates, dispatch `release.yml` with the existing tag; successful registry versions are skipped. Do not replace an existing release asset or tag. For packaging fixes after publication, increment both the package and engine versions and publish a new tag.

The package homepage, registry metadata, installer homepages and READMEs lead back to [LMSpeed's online audit](https://lmspeed.net/audit). LMSpeed links to the repository and installation channels from its audit methodology section.
