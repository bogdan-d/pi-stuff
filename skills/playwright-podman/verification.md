# Runtime verification

Run after changing the image, CLI version, or browser configuration. These checks exercise the built runtime, not skill triggering or comparative token efficiency.

1. Run `pw build` and `pw start` using `SKILL.md`, including from outside the repository through the installed launcher. Use the returned handle as `$BROWSER` in the low-level inspection below.
2. Confirm `podman inspect "$BROWSER" --format '{{json .Mounts}} {{.Config.User}} {{.HostConfig.NetworkMode}}'` reports no mounts, `pwuser`, and `host`.
3. Run `pw "$BROWSER" goto chrome://sandbox`, then `pw "$BROWSER" eval '() => document.body.innerText'`. Require namespace and Seccomp-BPF sandboxes enabled. A missing sandbox is a failure, not a reason to weaken launch settings.
4. Navigate to `https://playwright.dev`. Search for a specific heading and follow a documentation link using a current ref or role locator. Confirm the resulting URL.
5. Open an app bound to host localhost. Fill a control and act on it through separate CLI invocations. Assert the resulting UI state through `run-code`; verify snapshot search returns that state.
6. Set a synthetic localStorage value, confirm it survives another CLI invocation, close and reopen the browser on the same origin, then assert the value is absent.
7. Capture a screenshot through the wrapper and copy it out with `pw "$BROWSER" export`. Read a snapshot range with `pw "$BROWSER" read`. Inspect the image. Confirm no mount was needed.
8. Start a second task with the wrapper. Set a distinct synthetic value on the same origin and verify neither container sees the other's value. Run wrapper `stop` for each and verify neither remains in `podman ps -a`.

Keep assertions in the trial output. CLI output can contain an error even when a shell pipeline succeeds; inspect results rather than treating the final command's exit status as proof.

## Loopback access policy

After changing the image policy, open `chrome://policy` and confirm `LoopbackNetworkAllowedForUrls` has value `["*"]` and status `OK`. From an authorized HTTPS site that loads a host-loopback development resource, verify the resource loads without permission grants or request interception. Normal CORS restrictions still apply. Recheck `chrome://sandbox` to confirm the browser sandbox remains enabled.

## Authentication and uploads

Run `bun skills/playwright-podman/tool/verify-imports.ts` from the repository root. This opt-in check needs Podman and the built image. It starts a localhost fixture and a disposable browser, imports synthetic authentication, verifies an authenticated request, imports a file with spaces in its name, and uploads through the site's file chooser. It also checks private failure output and removal of temporary auth files. It cleans up its browser, server, and host fixture files.

Ordinary `bun test` covers malformed state and file-source validation without requiring Podman or real credentials.

## Version selection

`tool/package.json` and `tool/package-lock.json` pin the agent CLI and its exact Playwright dependencies. The selected CLI release depends on an alpha Playwright version. The base image tag alone therefore does not establish compatibility. The explicit browser install during build selects the dependency's required browser revision.

Primary references:

- https://github.com/microsoft/playwright-cli
- https://playwright.dev/docs/docker
- https://playwright.dev/docs/api/class-browsertype#browser-type-launch
- https://docs.podman.io/en/latest/markdown/podman-run.1.html
