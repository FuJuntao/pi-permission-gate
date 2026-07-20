/**
 * Knowledge base of common commands: read-only by default, flag-dependent,
 * or always mutating. Unknown binaries are the classifier's problem, not
 * this file's — anything not listed here classifies as "unknown".
 */

export type CommandBehavior = "readonly" | "mutating" | "unknown";

export interface CommandRule {
	/** Base behavior when no flags/subcommand say otherwise. */
	behavior: CommandBehavior;
	/** Flags that flip a readonly command to mutating (short or long). */
	writeFlags?: string[];
	/** Subcommand → behavior map. Unlisted subcommands fall back to `behavior`. */
	subcommands?: Record<string, CommandBehavior>;
	/** True when the binary executes arbitrary other commands (xargs, env...). */
	executesArgs?: boolean;
}

const DB: Record<string, CommandRule> = {
	// ----- simple read-only -----
	ls: { behavior: "readonly" },
	cat: { behavior: "readonly" },
	head: { behavior: "readonly" },
	tail: { behavior: "readonly" },
	less: { behavior: "readonly" },
	more: { behavior: "readonly" },
	wc: { behavior: "readonly" },
	file: { behavior: "readonly" },
	stat: { behavior: "readonly" },
	grep: { behavior: "readonly" },
	egrep: { behavior: "readonly" },
	fgrep: { behavior: "readonly" },
	rg: { behavior: "readonly" },
	ag: { behavior: "readonly" },
	ack: { behavior: "readonly" },
	cut: { behavior: "readonly" },
	sort: { behavior: "readonly", writeFlags: ["-o", "--output"] },
	uniq: { behavior: "readonly" },
	tr: { behavior: "readonly" },
	diff: { behavior: "readonly" },
	comm: { behavior: "readonly" },
	join: { behavior: "readonly" },
	paste: { behavior: "readonly" },
	column: { behavior: "readonly" },
	jq: { behavior: "readonly" },
	yq: { behavior: "readonly", writeFlags: ["-i", "--inplace"] },
	xsv: { behavior: "readonly" },
	pwd: { behavior: "readonly" },
	echo: { behavior: "readonly" },
	printf: { behavior: "readonly" },
	true: { behavior: "readonly" },
	false: { behavior: "readonly" },
	test: { behavior: "readonly" },
	"[": { behavior: "readonly" },
	which: { behavior: "readonly" },
	whereis: { behavior: "readonly" },
	type: { behavior: "readonly" },
	whoami: { behavior: "readonly" },
	id: { behavior: "readonly" },
	hostname: { behavior: "readonly" },
	uname: { behavior: "readonly" },
	date: { behavior: "readonly" },
	env: { behavior: "readonly", executesArgs: true }, // `env cmd` runs cmd
	printenv: { behavior: "readonly" },
	df: { behavior: "readonly" },
	du: { behavior: "readonly" },
	free: { behavior: "readonly" },
	uptime: { behavior: "readonly" },
	ps: { behavior: "readonly" },
	top: { behavior: "readonly" },
	htop: { behavior: "readonly" },
	lsblk: { behavior: "readonly" },
	lsusb: { behavior: "readonly" },
	lspci: { behavior: "readonly" },
	lsof: { behavior: "readonly" },
	ss: { behavior: "readonly" },
	netstat: { behavior: "readonly" },
	ip: { behavior: "readonly" },
	ifconfig: { behavior: "readonly" },
	find: { behavior: "readonly", writeFlags: ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fls", "-fprint", "-fprintf"] },
	fd: { behavior: "readonly", writeFlags: ["-x", "--exec", "-X", "--exec-batch"] },
	tree: { behavior: "readonly" },
	realpath: { behavior: "readonly" },
	readlink: { behavior: "readonly" },
	basename: { behavior: "readonly" },
	dirname: { behavior: "readonly" },
	md5sum: { behavior: "readonly" },
	sha1sum: { behavior: "readonly" },
	sha256sum: { behavior: "readonly" },
	cksum: { behavior: "readonly" },
	xxd: { behavior: "readonly" },
	od: { behavior: "readonly" },
	hexdump: { behavior: "readonly" },
	tac: { behavior: "readonly" },
	nl: { behavior: "readonly" },
	rev: { behavior: "readonly" },
	shuf: { behavior: "readonly", writeFlags: ["-o", "--output"] },
	seq: { behavior: "readonly" },
	yes: { behavior: "readonly" },
	cal: { behavior: "readonly" },
	man: { behavior: "readonly" },
	info: { behavior: "readonly" },
	apropos: { behavior: "readonly" },
	base64: { behavior: "readonly" },
	time: { behavior: "readonly", executesArgs: true },
	watch: { behavior: "readonly", executesArgs: true },

	// ----- network fetches (read-only w.r.t. local system unless -o/-O/upload) -----
	curl: { behavior: "readonly", writeFlags: ["-o", "-O", "--output", "--remote-name", "-T", "--upload-file", "-F", "--form", "-d", "--data", "--data-binary", "--data-raw", "--data-urlencode", "-X", "--request"] },
	wget: { behavior: "readonly", writeFlags: ["-O", "--output-document", "--post-data", "--post-file", "--method", "--body-data"] },
	ping: { behavior: "readonly" },
	dig: { behavior: "readonly" },
	nslookup: { behavior: "readonly" },
	host: { behavior: "readonly" },
	traceroute: { behavior: "readonly" },

	// ----- archives -----
	tar: { behavior: "readonly" }, // special-cased in classifier (c/x in bundled flags)
	unzip: { behavior: "mutating" }, // extracts to disk
	zip: { behavior: "mutating" },
	gzip: { behavior: "mutating" }, // compresses in place (removes original)
	gunzip: { behavior: "mutating" },
	bzip2: { behavior: "mutating" },
	xz: { behavior: "mutating" },
	zstd: { behavior: "mutating" },

	// ----- editors / interpreters -----
	vim: { behavior: "mutating" },
	nvim: { behavior: "mutating" },
	emacs: { behavior: "mutating" },
	nano: { behavior: "mutating" },
	code: { behavior: "mutating" },
	sed: { behavior: "readonly", writeFlags: ["-i", "--in-place"] },
	awk: { behavior: "readonly" }, // redirections/system() inside program are opaque → classifier treats args with > as writes
	perl: { behavior: "readonly" }, // one-liners can do anything → classifier marks -e as unknown
	ruby: { behavior: "readonly" },
	python: { behavior: "readonly" },
	python3: { behavior: "readonly" },
	node: { behavior: "readonly" },
	deno: { behavior: "readonly", writeFlags: ["run", "install", "add", "remove", "task"] },
	bun: { behavior: "readonly" },
	php: { behavior: "readonly" },
	lua: { behavior: "readonly" },

	// ----- version control -----
	git: {
		behavior: "readonly",
		subcommands: {
			// read-only
			status: "readonly", diff: "readonly", log: "readonly", show: "readonly",
			blame: "readonly", annotate: "readonly", branch: "readonly", tag: "readonly",
			remote: "readonly", config: "readonly", describe: "readonly", "rev-parse": "readonly",
			"rev-list": "readonly", "ls-files": "readonly", "ls-tree": "readonly", "ls-remote": "readonly",
			"cat-file": "readonly", "name-rev": "readonly", "name-status": "readonly",
			shortlog: "readonly", reflog: "readonly", stash: "readonly", grep: "readonly",
			archive: "readonly", "count-objects": "readonly", "verify-commit": "readonly",
			"verify-tag": "readonly", fsck: "readonly", "show-branch": "readonly",
			whatchanged: "readonly", "range-diff": "readonly", "for-each-ref": "readonly",
			// mutating
			add: "mutating", commit: "mutating", push: "mutating", pull: "mutating",
			fetch: "mutating", clone: "mutating", checkout: "mutating", switch: "mutating",
			restore: "mutating", merge: "mutating", rebase: "mutating", reset: "mutating",
			clean: "mutating", rm: "mutating", mv: "mutating", "cherry-pick": "mutating",
			revert: "mutating", amend: "mutating", init: "mutating", worktree: "mutating",
			submodule: "mutating", apply: "mutating", bisect: "mutating", gc: "mutating",
			prune: "mutating", "update-index": "mutating", "update-ref": "mutating",
		},
	},
	svn: {
		behavior: "readonly",
		subcommands: {
			status: "readonly", diff: "readonly", log: "readonly", info: "readonly",
			list: "readonly", blame: "readonly", cat: "readonly",
			checkout: "mutating", update: "mutating", commit: "mutating", add: "mutating",
			delete: "mutating", merge: "mutating", revert: "mutating", cleanup: "mutating",
		},
	},
	hg: {
		behavior: "readonly",
		subcommands: {
			status: "readonly", diff: "readonly", log: "readonly", id: "readonly",
			summary: "readonly", commit: "mutating", push: "mutating", pull: "mutating",
			update: "mutating", merge: "mutating", revert: "mutating", add: "mutating",
		},
	},
	gh: {
		behavior: "readonly",
		subcommands: {
			status: "readonly", view: "readonly", list: "readonly", search: "readonly",
			diff: "readonly", checks: "readonly", api: "readonly",
			create: "mutating", merge: "mutating", close: "mutating", edit: "mutating",
			delete: "mutating", release: "mutating", run: "mutating", workflow: "mutating",
			repo: "mutating", issue: "mutating", pr: "mutating",
		},
	},

	// ----- containers / infra -----
	docker: {
		behavior: "readonly",
		subcommands: {
			ps: "readonly", images: "readonly", inspect: "readonly", logs: "readonly",
			stats: "readonly", top: "readonly", version: "readonly", info: "readonly",
			history: "readonly", diff: "readonly", port: "readonly", search: "readonly",
			run: "mutating", exec: "mutating", build: "mutating", push: "mutating",
			pull: "mutating", rm: "mutating", rmi: "mutating", stop: "mutating",
			start: "mutating", restart: "mutating", kill: "mutating", prune: "mutating",
			volume: "mutating", network: "mutating", compose: "mutating", tag: "mutating",
			save: "mutating", load: "mutating", export: "mutating", import: "mutating",
			system: "mutating", container: "mutating", image: "mutating",
		},
	},
	kubectl: {
		behavior: "readonly",
		subcommands: {
			get: "readonly", describe: "readonly", logs: "readonly", explain: "readonly",
			version: "readonly", "api-resources": "readonly", "api-versions": "readonly",
			config: "readonly", top: "readonly", "cluster-info": "readonly",
			apply: "mutating", delete: "mutating", create: "mutating", edit: "mutating",
			patch: "mutating", replace: "mutating", scale: "mutating", rollout: "mutating",
			exec: "mutating", drain: "mutating", cordon: "mutating", uncordon: "mutating",
			taint: "mutating", label: "mutating", annotate: "mutating",
		},
	},
	terraform: {
		behavior: "readonly",
		subcommands: {
			plan: "readonly", show: "readonly", output: "readonly", state: "readonly",
			validate: "readonly", fmt: "mutating", init: "mutating", apply: "mutating",
			destroy: "mutating", import: "mutating", taint: "mutating", untaint: "mutating",
			workspace: "mutating",
		},
	},

	// ----- package managers -----
	npm: {
		behavior: "readonly",
		subcommands: {
			ls: "readonly", list: "readonly", outdated: "readonly", why: "readonly",
			view: "readonly", info: "readonly", search: "readonly", audit: "readonly",
			config: "readonly", cache: "readonly", prefix: "readonly", root: "readonly",
			version: "readonly", help: "readonly", doctor: "readonly", fund: "readonly",
			dedupe: "mutating", install: "mutating", i: "mutating", ci: "mutating",
			uninstall: "mutating", remove: "mutating", update: "mutating",
			publish: "mutating", unpublish: "mutating", run: "mutating", "run-script": "mutating",
			test: "mutating", start: "mutating", exec: "unknown", init: "mutating",
			link: "mutating", unlink: "mutating", prune: "mutating", rebuild: "mutating",
			pack: "mutating", deprecate: "mutating", token: "mutating", login: "mutating",
			logout: "mutating", owner: "mutating", access: "mutating",
		},
	},
	pnpm: {
		behavior: "readonly",
		subcommands: {
			ls: "readonly", list: "readonly", outdated: "readonly", why: "readonly",
			audit: "readonly", store: "readonly",
			install: "mutating", i: "mutating", add: "mutating", remove: "mutating",
			update: "mutating", publish: "mutating", run: "mutating", exec: "mutating",
			dlx: "mutating", create: "mutating", init: "mutating", link: "mutating",
		},
	},
	yarn: {
		behavior: "readonly",
		subcommands: {
			list: "readonly", outdated: "readonly", why: "readonly", info: "readonly",
			audit: "readonly", config: "readonly",
			install: "mutating", add: "mutating", remove: "mutating", up: "mutating",
			publish: "mutating", run: "mutating", exec: "mutating", dlx: "mutating",
			init: "mutating", link: "mutating", unlink: "mutating",
		},
	},
	pip: { behavior: "readonly", subcommands: { list: "readonly", show: "readonly", freeze: "readonly", check: "readonly", install: "mutating", uninstall: "mutating", download: "mutating", wheel: "mutating" } },
	pip3: { behavior: "readonly", subcommands: { list: "readonly", show: "readonly", freeze: "readonly", check: "readonly", install: "mutating", uninstall: "mutating", download: "mutating", wheel: "mutating" } },
	cargo: {
		behavior: "readonly",
		subcommands: {
			search: "readonly", tree: "readonly", metadata: "readonly", version: "readonly",
			check: "mutating", build: "mutating", run: "mutating", test: "mutating",
			install: "mutating", uninstall: "mutating", update: "mutating", publish: "mutating",
			add: "mutating", remove: "mutating", clean: "mutating", doc: "mutating",
			fmt: "mutating", clippy: "mutating", new: "mutating", init: "mutating",
			bench: "mutating", fix: "mutating",
		},
	},
	go: {
		behavior: "readonly",
		subcommands: {
			env: "readonly", version: "readonly", list: "readonly", doc: "readonly",
			build: "mutating", run: "mutating", test: "mutating", install: "mutating",
			get: "mutating", mod: "mutating", clean: "mutating", generate: "mutating",
			fmt: "mutating", vet: "readonly", work: "mutating", tool: "mutating",
		},
	},
	make: { behavior: "mutating" }, // runs arbitrary recipes
	cmake: { behavior: "mutating" },
	ninja: { behavior: "mutating" },

	// ----- system / package management -----
	apt: { behavior: "mutating", subcommands: { list: "readonly", show: "readonly", search: "readonly", policy: "readonly" } },
	"apt-get": { behavior: "mutating" },
	dpkg: { behavior: "readonly", writeFlags: ["-i", "--install", "-r", "--remove", "-P", "--purge", "--configure"] },
	brew: {
		behavior: "readonly",
		subcommands: {
			list: "readonly", info: "readonly", search: "readonly", outdated: "readonly",
			leaves: "readonly", deps: "readonly", uses: "readonly", config: "readonly",
			doctor: "readonly", install: "mutating", uninstall: "mutating", upgrade: "mutating",
			update: "mutating", tap: "mutating", untap: "mutating", services: "mutating",
			cleanup: "mutating", pin: "mutating", unpin: "mutating", reinstall: "mutating",
		},
	},
	systemctl: { behavior: "readonly", subcommands: { status: "readonly", "list-units": "readonly", "list-timers": "readonly", "list-jobs": "readonly", "list-dependencies": "readonly", "is-active": "readonly", "is-enabled": "readonly", "is-failed": "readonly", show: "readonly", cat: "readonly", help: "readonly" } },
	journalctl: { behavior: "readonly" },
	crontab: { behavior: "readonly", writeFlags: ["-e", "-r", "-i"] },

	// ----- file mutations -----
	cp: { behavior: "mutating" },
	mv: { behavior: "mutating" },
	rm: { behavior: "mutating" },
	mkdir: { behavior: "mutating" },
	rmdir: { behavior: "mutating" },
	touch: { behavior: "mutating" },
	chmod: { behavior: "mutating" },
	chown: { behavior: "mutating" },
	chgrp: { behavior: "mutating" },
	ln: { behavior: "mutating" },
	tee: { behavior: "mutating" }, // writes files by design
	dd: { behavior: "mutating" },
	mktemp: { behavior: "mutating" },
	install: { behavior: "mutating" },
	patch: { behavior: "mutating" },
	mount: { behavior: "mutating" },
	umount: { behavior: "mutating" },

	// ----- process control -----
	kill: { behavior: "mutating" },
	pkill: { behavior: "mutating" },
	killall: { behavior: "mutating" },
	shutdown: { behavior: "mutating" },
	reboot: { behavior: "mutating" },
	halt: { behavior: "mutating" },
	poweroff: { behavior: "mutating" },
	sleep: { behavior: "readonly" },

	// ----- user / auth -----
	passwd: { behavior: "mutating" },
	useradd: { behavior: "mutating" },
	userdel: { behavior: "mutating" },
	usermod: { behavior: "mutating" },
	groupadd: { behavior: "mutating" },
	sudo: { behavior: "mutating", executesArgs: true },
	su: { behavior: "mutating", executesArgs: true },
	doas: { behavior: "mutating", executesArgs: true },
	ssh: { behavior: "mutating", executesArgs: true }, // runs remote commands, opaque
	scp: { behavior: "mutating" },
	sftp: { behavior: "mutating" },
	rsync: { behavior: "mutating" }, // writes by default; --dry-run handled by classifier
	gpg: { behavior: "mutating", subcommands: { "--list-keys": "readonly", "--list-secret-keys": "readonly", "--fingerprint": "readonly", "--verify": "readonly" } },

	// ----- shells / evaluators: never trust -----
	eval: { behavior: "mutating", executesArgs: true },
	exec: { behavior: "mutating", executesArgs: true },
	source: { behavior: "mutating", executesArgs: true },
	".": { behavior: "mutating", executesArgs: true },
	bash: { behavior: "mutating", executesArgs: true },
	sh: { behavior: "mutating", executesArgs: true },
	zsh: { behavior: "mutating", executesArgs: true },
	fish: { behavior: "mutating", executesArgs: true },
	dash: { behavior: "mutating", executesArgs: true },
	ksh: { behavior: "mutating", executesArgs: true },
	xargs: { behavior: "mutating", executesArgs: true },
	parallel: { behavior: "mutating", executesArgs: true },
	nohup: { behavior: "mutating", executesArgs: true },
	nice: { behavior: "mutating", executesArgs: true },
	timeout: { behavior: "mutating", executesArgs: true },
};

/** Binaries that must NEVER be treated as read-only regardless of args. */
const ALWAYS_MUTATING = new Set(
	Object.entries(DB)
		.filter(([, r]) => r.behavior === "mutating" && !r.subcommands && !r.writeFlags)
		.map(([name]) => name),
);

export function lookupRule(binary: string): CommandRule | undefined {
	return DB[binary];
}

export function isKnownBinary(binary: string): boolean {
	return binary in DB;
}

export function isAlwaysMutating(binary: string): boolean {
	return ALWAYS_MUTATING.has(binary);
}

