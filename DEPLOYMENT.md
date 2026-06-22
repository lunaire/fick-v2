# Deployment

This app lives in two places, kept in sync automatically:

- **GitHub** — [`lunaire/fick-v2`](https://github.com/lunaire/fick-v2), the source of truth for the code.
- **Live site** — https://aclinicaltool.com/apps/fick-cardiac-output-calculator/, served from a
  Cloudflare Worker (`aclinicaltool`) backed by D1 + R2. That Worker hosts several unrelated tools
  on the same multi-tool portfolio site (ICU List, CCU Procedure Cart List, CCU Cart Data) — only
  this repo's files are this app's concern.

## How the sync works

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) runs on every push to `master` that
touches an app file (or manually: GitHub → Actions → "Deploy to aclinicaltool.com" → Run workflow).
It:

1. Zips `index.html`, `app.js`, `style.css`, `ocr.js`, `ocr.css`, `ai-extract.js`, and `vendor/**`
   (the offline Tesseract OCR assets).
2. `PUT`s the zip to the Worker's `/api/admin/upload` endpoint with metadata headers.

The Worker matches the upload to the existing catalog entry **by title**
("Fick Cardiac Output Calculator"), so this always updates the same tool in place — same slug,
same public URL, no duplicates.

**Bottom line: pushing to `master` is enough.** No manual zip/upload step needed anymore.

## The admin secret

The workflow authenticates with the Worker's `ADMIN_TOKEN`, stored as the GitHub Actions secret
**`ACLINICALTOOL_ADMIN_TOKEN`** (repo Settings → Secrets and variables → Actions).

If the Worker's token is ever rotated (`wrangler secret put ADMIN_TOKEN`, against the
`aclinicaltool` Worker), update the GitHub secret to match:

```
gh secret set ACLINICALTOOL_ADMIN_TOKEN --repo lunaire/fick-v2
```

(Cloudflare Worker secrets are write-only — there's no API to read the current value back, so if
it's ever lost, set a new one in both places.)

## Manual fallback

If the Action ever fails, the same upload can be done by hand from a Linux/macOS/WSL/Git-Bash shell:

```bash
zip -r fick-app.zip index.html app.js style.css ocr.js ocr.css ai-extract.js vendor
curl -X PUT https://aclinicaltool.com/api/admin/upload \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "X-File-Name: fick-app.zip" \
  -H "X-File-Title: Fick Cardiac Output Calculator" \
  -H "X-File-Category: app" \
  -H "X-File-Type: Calculator" \
  -H "X-File-Tags: cardiac-output,hemodynamics,fick,clinical-calculator" \
  --data-binary @fick-app.zip
```

> **Windows note:** don't build the zip with PowerShell's `Compress-Archive` — it stores
> backslash-separated paths for nested folders, which breaks the Worker's (forward-slash) unzip
> logic for everything under `vendor/tesseract/...`. Use `zip` (Git Bash/WSL) or build the archive
> via `System.IO.Compression.ZipFile` with paths explicitly normalized to forward slashes.
