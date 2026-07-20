# pi-permission-gate

A [pi](https://github.com/earendil-works/pi-mono) extension that prompts for confirmation before running potentially dangerous bash commands.

## What it blocks

- `rm -rf` / `rm -r` / `rm --recursive` / `rm --force`
- `sudo` commands
- `chmod 777` / `chown 777`
- `mkfs`
- `dd of=...`
- Redirects to block devices (`> /dev/sd...`)
- `shutdown` / `reboot` / `halt`
- `kill -9` / `pkill -9`
- `git push --force`
- `npm publish` / `npm unpublish`

In interactive mode, you get a confirmation dialog. In non-interactive mode (`-p`, JSON), dangerous commands are blocked outright.

## Install

```bash
pi install git:github.com/fujuntao/pi-permission-gate
```

Or try it without installing:

```bash
pi -e git:github.com/fujuntao/pi-permission-gate
```

Or copy to your global extensions directory:

```bash
cp src/index.ts ~/.pi/agent/extensions/permission-gate.ts
```

## Development

```bash
cd main
npm install
npm run check   # type-check
```

## License

MIT
