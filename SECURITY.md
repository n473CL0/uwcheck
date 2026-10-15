# Security

UWCheck stores your Canvas feed URL and Ed API token on your computer, so security bugs matter.

## Reporting a problem

Please **don't open a public issue**. Report it privately through [GitHub's private vulnerability reporting](https://github.com/n473CL0/uwcheck/security/advisories/new). You'll get a reply within a week.

Things worth reporting:

- A token or feed URL sent anywhere other than its own service, or shown to the page
- Another website or another device on the network reaching the local server (it should only answer `localhost`)
- Anything that can read or change `~/.uwcheck` from outside UWCheck

## Supported versions

Only the latest version on npm gets fixes. The app shows an **Update** button when one is out.
