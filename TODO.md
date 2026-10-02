# TODO

## Publish the browser extension to the Chrome Web Store

Waiting on the developer account. Chrome won't let any outside program install an extension into a profile, so the store is the only way to make "add the button" a one-click step with no Developer mode.

1. Create the Chrome Web Store developer account (one-time $5 fee, Google account).
2. Prepare the listing (ask Claude to do this part):
   - zip of `extension/` with the production manifest
   - screenshots (1280x800) and a small promo tile (440x280)
   - description, single-purpose statement, and a privacy policy page (the extension collects nothing; it only talks to `127.0.0.1`)
   - justification for each permission: `proxy`, `privacy`, `storage`, `alarms`, host access to `127.0.0.1`, `ipwho.is`, `api.ipify.org`
3. Submit as **Unlisted** (only people with the link can find it). Review usually takes a few days.
4. After approval:
   - note the store URL and the permanent extension ID
   - change the "Add button" dialog in `src/ui/views/AppsView.tsx` to open the store page in that profile (`openProfile(...)` with the store URL) instead of the four manual steps
   - drop copying the extension into the data folder (`installExtension` in `src/core/core.ts`) and the `/browser-setup` page in `src/core/server.ts`
5. Keep the version in `extension/manifest.json` in step with `package.json` for each store update.
