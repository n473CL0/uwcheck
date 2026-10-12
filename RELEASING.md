# Releasing UWCheck

Pushing a version tag to GitHub publishes it to npm automatically, via [`.github/workflows/publish.yml`](.github/workflows/publish.yml).

## One-time setup

1. On [npmjs.com](https://www.npmjs.com/package/uwcheck), open **uwcheck → Settings → Trusted Publisher** and choose **GitHub Actions**:
   - Organization or user: `n473CL0`
   - Repository: `uwcheck`
   - Workflow filename: `publish.yml`
   - Environment: leave blank
2. Optional but recommended: on the same page, under **Publishing access**, choose **Require two-factor authentication and disallow tokens**. GitHub Actions can still publish, but nobody can publish with a leaked npm token.

## Each release

```sh
uwcheck --stop          # free port 7351 so you can test the repo copy
npm start               # test your changes, then Ctrl+C
git add -A
git commit -m "Describe the change"
npm version patch       # bug fix: 1.1.0 -> 1.1.1  (minor = new feature, major = breaking change)
git push --follow-tags
```

`npm version` updates `package.json`, commits it and creates a `vX.Y.Z` tag. Pushing the tag starts the workflow. It checks that the tag matches `package.json`, runs a quick smoke test, and publishes to npm. You can watch it under the repo's **Actions** tab.

If npm puts the release into staged review, approve it on npmjs.com. Users don't get the new version until `npm view uwcheck dist-tags` shows it as `latest`.

## What users see

Within a day, everyone's dashboard shows an **Update to X.Y.Z** button that copies `npm install -g uwcheck@latest`. If they opened UWCheck from the app icon, it restarts onto the new version by itself about a minute after they install it, and the open window reloads.
