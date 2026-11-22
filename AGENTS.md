# LMSpeed Audit

Canonical repository: https://github.com/lmspeed/audit. Keep the repository name `audit` lowercase to match the validated npm OIDC publisher; identity changes must update that binding and pass the CI authentication check. Both npm registries use `@lmspeed/audit`; the command remains `lmspeed-audit`.

## Development

- Use pnpm and TypeScript.
- Run `pnpm check` before shipping changes. It verifies formatting, types, test governance, coverage and the installable npm package.
- Run `pnpm release:prepare` and `pnpm release:smoke` when changing distribution artifacts or installation contracts.
- Keep npm tarballs, portable archives and all required license notices usable outside the source workspace.

## Publish through CI/CD

The user requires releases to be controlled through GitHub Actions. Use `.github/workflows/release.yml` for npm, GitHub Packages, GitHub Releases, Homebrew and Scoop publication. Local commands may build and verify artifacts; routine publication must not use local `npm publish`, `pnpm publish` or manual release-asset uploads.

1. Update `package.json`, `ENGINE_VERSION` and every localized changelog for a new version.
2. Complete the local checks, commit the release, and push its stable `vX.Y.Z` tag. The tag automatically starts the release workflow.
3. For a retry of an existing release using the current artifact format, trigger:

   ```sh
   gh workflow run release.yml --repo lmspeed/audit --ref main -f tag=vX.Y.Z
   ```

4. Inspect the workflow's checks and registry/installer results. Report the release URL and distinguish a running pipeline from a completed publication.

Normal npm releases use OIDC, without a stored personal npm token or interactive verification. Changing the trusted publisher's identity is a separate account-management operation. GitHub Packages uses this repository's `GITHUB_TOKEN` with `packages: write`.

Never move an existing release tag or replace its published assets. Retries reuse the immutable release files and skip existing registry versions. A packaging fix requires a new version. Releases before 0.3.3 retain their historical package namespace and artifact names; do not republish them under the new namespace.

See [the publishing runbook](docs/releasing.md) for registry configuration and installer details.
