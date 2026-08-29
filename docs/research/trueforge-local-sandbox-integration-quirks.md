# TrueForge local-sandbox integration quirks

Research date: 2026-08-29

This note records the local-sandbox failures observed during the TrueForge
producer-turn prototype and checks whether an upstream upgrade removes them.
It covers the Linux local sandbox only; it does not assess Daytona or another
remote sandbox provider.

## Conclusion

Do not treat a TrueForge or Sandbox Runtime upgrade as the fix for the proxy
socket problem yet.

- The prototype uses TrueForge `0.1.4`, which pins
  `@anthropic-ai/sandbox-runtime` `0.0.71`. The newest published TrueForge
  release candidate, `0.2.0-rc.0`, still pins `0.0.71` in its
  [official package manifest](https://github.com/truefoundry/trueforge/blob/main/packages/trueforge/package.json#L56-L63).
- The newest published Sandbox Runtime is `0.0.74`, and its current
  [official package manifest](https://github.com/anthropic-experimental/sandbox-runtime/blob/main/package.json#L1-L12)
  identifies that same version. However, current upstream Linux source still
  adds the HTTP/SOCKS socket binds first and only appends filesystem restriction
  arguments afterward
  ([socket binds](https://github.com/anthropic-experimental/sandbox-runtime/blob/main/src/sandbox/linux-sandbox-utils.ts#L1737-L1766),
  [filesystem arguments](https://github.com/anthropic-experimental/sandbox-runtime/blob/main/src/sandbox/linux-sandbox-utils.ts#L1817-L1828)).
- The exact interaction is already reported upstream: denying reads to `/tmp`
  hides Sandbox Runtime's `/tmp/claude-http-*.sock` bridge and breaks network
  access; the report also notes that a corrective bind must come after the
  `--tmpfs` mount. The upstream issue remains open
  ([anthropic-experimental/sandbox-runtime#176](https://github.com/anthropic-experimental/sandbox-runtime/issues/176)).

The robust upstream correction is the ordering change proven in the prototype:
emit the internal proxy-socket binds after all read-deny/write-policy mounts,
then protect this with a Linux regression test using a broad read deny and a
real proxied request. Until that lands in a released dependency, use a pinned,
reviewed package patch or fork applied by the package manager/build—not a
manual edit to installed `node_modules`—and make the regression test an upgrade
gate.

## Why TrueForge triggers the bug

TrueForge deliberately applies a deny-by-default read policy to local commands:
`denyRead: ['/']`, with only the sandbox root, Code Mode socket directory, and
curated system paths re-allowed
([TrueForge filesystem policy](https://github.com/truefoundry/trueforge/blob/main/packages/trueforge/src/sandbox/local/core/hostRun.ts#L237-L252)).
Sandbox Runtime creates its own host-side HTTP and SOCKS Unix sockets under the
operating-system temporary directory
([bridge initialization](https://github.com/anthropic-experimental/sandbox-runtime/blob/main/src/sandbox/linux-sandbox-utils.ts#L545-L580)).

On Linux, Bubblewrap processes mount operations in argument order. The early
socket bind is therefore covered by the later tmpfs used to implement the
broad read deny. The inner `socat` process can no longer see the pathname and
returns an empty/disconnected proxy response. That is why pip eventually
reported both proxy connection failures and the misleading terminal message
"No matching distribution found": it never obtained the package index.

TrueForge already sets `allowAllUnixSockets: true` on Linux, but that only
disables Sandbox Runtime's seccomp block on creating Unix sockets; TrueForge's
own source notes that pathname connection still requires filesystem visibility
([TrueForge Linux socket policy](https://github.com/truefoundry/trueforge/blob/main/packages/trueforge/src/sandbox/local/core/hostRun.ts#L293-L319)).
Consequently, toggling `allowAllUnixSockets` is not a fix for a Bubblewrap mount
that hides the proxy socket.

## Recommended production treatment

1. **Prefer the upstream ordering fix.** Track Sandbox Runtime issue #176 and
   adopt a release only after its generated Bubblewrap arguments or an
   end-to-end test prove that the proxy socket is mounted above broad read-deny
   mounts.
2. **Until then, carry a reproducible package patch or narrow fork.** Pin the
   exact Sandbox Runtime version and integrity, apply only the mount-order
   change during install/build, and fail CI if the patch no longer applies.
   Never mutate a deployed `node_modules` tree by hand.
3. **Add a mandatory Linux smoke test.** With `denyRead: ['/']` and only the
   intended sandbox/system paths allowed, create a fresh sandbox and install a
   small package through the actual proxy. Assert both network success and that
   an unrelated host temporary file remains unreadable. This catches both the
   original outage and an unsafe workaround that exposes all of `/tmp`.
4. **Do not broadly allow-read `/tmp`.** That restores the socket at the cost of
   exposing unrelated host temporary files to untrusted code. A future API that
   exposes or relocates only Sandbox Runtime's private socket directory could be
   safe, but the current public flow generates the socket internally.
5. **A remote sandbox provider is an architectural alternative, not a drop-in
   patch.** TrueForge documents sandbox providers as pluggable and currently
   supports Daytona
   ([TrueForge overview](https://github.com/truefoundry/trueforge#readme)). It
   avoids this host-local SRT path, but requires separate infrastructure and its
   own security/availability validation.

## Host prerequisites and packaging quirks

### Linux sandbox tools

Sandbox Runtime officially requires `bubblewrap`, `socat`, and `ripgrep` on
Linux. `socat` relays traffic between the isolated network namespace and the
host proxy, while `ripgrep` supports deny-path discovery
([Sandbox Runtime platform dependencies](https://github.com/anthropic-experimental/sandbox-runtime/blob/main/README.md#platform-specific-dependencies)).
TrueForge independently probes the same three binaries before selecting its
local provider
([TrueForge host dependency list](https://github.com/truefoundry/trueforge/blob/main/packages/trueforge/src/sandbox/local/core/hostRun.ts#L108-L123)).

Production startup should fail fast with the resolved executable paths and
versions for all three rather than allowing the first model tool call to reveal
a missing binary. Sandbox Runtime also warns that Ubuntu 24.04+ AppArmor policy
can restrict the capability-bearing user namespaces required by Bubblewrap and
the seccomp layer; prefer a scoped AppArmor profile over globally weakening the
host when deploying on such systems
([official Ubuntu 24.04 note](https://github.com/anthropic-experimental/sandbox-runtime/blob/main/README.md#platform-specific-dependencies)).

### Python virtual environments and `ensurepip`

TrueForge creates each local sandbox's `.venv` with the selected host Python,
then runs a sandboxed import check and installs `pydantic>=2.0.0,<3.0.0` on
first use
([TrueForge `ensureVenv`](https://github.com/truefoundry/trueforge/blob/main/packages/trueforge/src/sandbox/local/provider/LocalSandboxProvider.ts#L462-L504)).

Python's `venv` invokes `ensurepip` unless `--without-pip` is requested
([Python 3.12 `venv` documentation](https://docs.python.org/3.12/library/venv.html)).
`ensurepip` itself does not use the network, but it is an optional distributor
module
([Python `ensurepip` documentation](https://docs.python.org/3/library/ensurepip.html)).
On Ubuntu 24.04, the `python3.12-venv` package supplies the Python 3.12
`ensurepip` files
([Ubuntu package file list](https://packages.ubuntu.com/noble/all/python3.12-venv/filelist)).

The production preflight must exercise the exact interpreter TrueForge resolves,
not merely check that `python3` exists:

```text
<resolved-python> -m ensurepip --version
<resolved-python> -m venv <disposable-probe-directory>
```

Remove the disposable probe afterward. Package the matching distro venv module
(for example, `python3.12-venv` when the resolved interpreter is Python 3.12)
into the host image.

### Dependency download through the sandbox proxy

Creating the venv is offline, but provisioning Pydantic is not. TrueForge's
fresh-sandbox path runs pip against `pypi.org` and
`files.pythonhosted.org`; those domains are present in its network allowlist
([allowlist](https://github.com/truefoundry/trueforge/blob/main/packages/trueforge/src/sandbox/local/core/hostRun.ts#L63-L83),
[install command](https://github.com/truefoundry/trueforge/blob/main/packages/trueforge/src/sandbox/local/provider/LocalSandboxProvider.ts#L478-L504)).
The `--trusted-host` flags in that command do not make an unreachable proxy
reachable. Proxy connectivity must work before pip can resolve any distribution.

For deterministic production startup, avoid making every fresh sandbox depend
on live PyPI. A maintained TrueForge change could ship an audited wheelhouse and
install with `--no-index --find-links`; pip officially supports local-only
resolution with those switches
([pip install documentation](https://pip.pypa.io/en/stable/cli/pip_install/#cmdoption-no-index)).
Pin the wheel and its transitive dependencies by version and hash rather than
retaining the current broad `pydantic>=2.0.0,<3.0.0` bootstrap range.
If online installation remains, preflight it through the same SRT policy and
surface proxy-connectivity failure separately from package-resolution failure.

## Diagnostic quirks to retain in the implementation backlog

- The proxy failure can surface as `RemoteDisconnected`, `Connection refused`,
  or ultimately `No matching distribution found`; classify it using the earlier
  proxy errors, not only pip's final line.
- Sandbox Runtime starts the host bridge with ignored stdio and starts the inner
  relays with output redirected to `/dev/null`
  ([host bridge](https://github.com/anthropic-experimental/sandbox-runtime/blob/main/src/sandbox/linux-sandbox-utils.ts#L581-L606),
  [inner relays](https://github.com/anthropic-experimental/sandbox-runtime/blob/main/src/sandbox/linux-sandbox-utils.ts#L736-L755)).
  A production integration should preserve sanitized relay diagnostics or run a
  targeted connectivity probe so an invisible socket failure is actionable.
- Pin and report the four independently moving versions: TrueForge server,
  TrueForge SDK, Sandbox Runtime, and the resolved Python interpreter. A
  successful UI load does not prove local-sandbox bootstrap.
- Treat sandbox creation, network bootstrap, skill mounting, model execution,
  and MCP commitment as separate observable phases. Retrying the whole turn can
  otherwise make one failed bootstrap look like duplicate model behavior.
