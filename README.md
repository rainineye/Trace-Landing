# Trace Landing

Static landing page for Trace, a claim intelligence infrastructure project for contested public claims.

The site is intentionally simple: a single `index.html` file deployed through Cloudflare Pages from GitHub.

## Live Site

Production domain:

```text
https://traceintelligence.io
```

Cloudflare Pages also provides a generated preview domain for deployments.

## Repository Structure

```text
.
├── index.html
└── README.md
```

## Deployment

This repository is connected to Cloudflare Pages through GitHub.

Recommended Cloudflare Pages settings:

```text
Framework preset: None
Build command: exit 0
Build output directory: /
Production branch: main
```

If Cloudflare does not accept `/` as the output directory, use:

```text
.
```

Every push to `main` triggers a new production deployment.

## Updating The Site

Edit `index.html`, then commit and push:

```bash
git add index.html
git commit -m "update landing page"
git push origin main
```

Cloudflare Pages will automatically rebuild and publish the latest version.

## Local Preview

Because this is a static HTML page, you can preview it by opening `index.html` in a browser.

For a local server preview:

```bash
python -m http.server 8000
```

Then open:

```text
http://localhost:8000
```

## Notes

- No JavaScript framework is required.
- No package install step is required.
- The production site is served by Cloudflare Pages.
- Custom domain configuration is managed in Cloudflare under the Pages project's Custom domains tab.
