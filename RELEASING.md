# Releasing pi-time-up

`pi-time-up` is currently distributed as a Git-based Pi package. The repository
is public, but the package is not published to npm by default.

## Before a release

From the repository root:

```bash
npm install
npm test
npm run check
npm run pack:check
git diff --check
```

Review the package contents and confirm that no credentials, tokens, personal
machine paths, local configuration, logs, or generated `node_modules/` files
are present.

## Release steps

1. Update `version` in `package.json`.
2. Refresh the lockfile and run the checks above:

   ```bash
   npm install --package-lock-only
   npm test
   npm run check
   npm run pack:check
   ```

3. Commit the release and create the matching tag:

   ```bash
   git add package.json package-lock.json README.md RELEASING.md LICENSE
   git commit -m "release: vX.Y.Z"
   git tag -a vX.Y.Z -m "pi-time-up vX.Y.Z"
   git push origin main --follow-tags
   ```

4. Update installed copies with the Git ref when a pinned release is desired:

   ```bash
   pi install git:git@github.com:leench/pi-time-up.git@vX.Y.Z
   ```

## Dotfiles integration

The extension is tracked in the dotfiles repository as a Git submodule at
`pi/extensions/pi-time-up`. After pushing a new extension commit or tag, update
the submodule pointer in the dotfiles repository and commit that pointer there.

Do not commit the local `time-up.json` configuration; it belongs under Pi's
user data directory and may contain private prompts or schedules.
