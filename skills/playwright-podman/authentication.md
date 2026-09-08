# Authentication import

Import only an account the user authorized for this task. State may grant access to multiple sites. The wrapper does not discover credentials or limit imported state to the current origin.

## Private file

Use standard Playwright storage-state JSON, saved outside repositories:

```bash
pw <session> auth /private/path/state.json
pw <session> goto https://example.com
```

Restrict the host file to your user, for example with `chmod 600`. The wrapper leaves the source file unchanged. It privately transfers the JSON, calls Playwright's `state-load`, and removes its temporary container copy even on failure. It suppresses upstream auth output to avoid disclosing state values.

Importing state does not prove the account is logged in. Navigate to the authorized site and check the expected account UI without printing cookies or tokens. If loading fails, state may be partially changed. Stop that task and start a fresh one before retrying.

## Paste locally

In your own terminal, run:

```bash
pw <session> auth -
```

Paste JSON, then press Enter and Ctrl-D. This reads stdin rather than putting the JSON in shell command history or process arguments. Terminal echo and scrollback can still show what you paste. Do not paste real credentials into agent chat, tool calls, or shared terminals.

## Simple cookie template

Replace the example fields with the actual cookie name, value, domain, path, and flags for your account:

```json
{
  "cookies": [
    {
      "name": "session",
      "value": "PASTE_COOKIE_VALUE_HERE",
      "domain": "example.com",
      "path": "/",
      "expires": -1,
      "httpOnly": true,
      "secure": true,
      "sameSite": "Lax"
    }
  ],
  "origins": []
}
```

This is a template, not a universal login cookie. Some sites need several cookies or localStorage entries. Preserve the real attributes, including a leading dot on the cookie domain if present. `expires: -1` denotes a session cookie, otherwise use the real Unix expiry timestamp in seconds. `sameSite` accepts `Strict`, `Lax`, or `None`.

Playwright-generated state files can also carry origin storage. Use them directly rather than converting browser-extension exports by guesswork. A raw `Cookie:` header or arbitrary cookie-export array is not this format. Playwright state does not automatically restore sessionStorage-dependent authentication.

`auth` stores no reusable host profile. Browser state remains sensitive until the task is stopped. Do not run `state-save`, cookie inspection, or broad storage evaluation on real accounts unless explicitly needed and authorized. Ordinary browser output can also contain private account content; report only what the task needs.
