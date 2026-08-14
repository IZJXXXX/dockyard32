# Release checklist

1. Run `pnpm install --frozen-lockfile` and `pnpm run ci` on Apple Silicon macOS.
2. Confirm that `stm32-workbench-<version>-darwin-arm64.vsix` passes both archive inspection and the unpacked-VSIX Extension Host test.
3. Push the release commit and wait for the GitHub Actions workflow named **macOS CI** to pass. Its **verify** job includes the fixed VS Code 1.96 test that is intentionally not part of the fast local CI command.
4. In GitHub repository **Settings → Rules → Rulesets**, protect `main`, require a pull request, and add **macOS CI / verify** as a required status check. Do not allow bypass for ordinary contributors.
5. Publish only the `darwin-arm64` VSIX under the matching Marketplace version, then create the GitHub Release and attach the same checked artifact.

The local repository cannot enforce a GitHub Ruleset. Treat Ruleset activation as a required repository-administration step before accepting external pull requests.
