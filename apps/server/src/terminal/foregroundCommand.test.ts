import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import {
  type ForegroundCommandSources,
  posixQuoteArgv,
  readForegroundCommand,
  readProcessCwd,
  restorableTerminalCommand,
} from "./foregroundCommand.ts";

const fakeSources = (input: {
  readonly files?: Record<string, string>;
  readonly links?: Record<string, string>;
  readonly commands?: Record<string, string>;
}) => {
  const requested: string[] = [];
  const sources: ForegroundCommandSources = {
    readText: (path) =>
      Effect.sync(() => {
        requested.push(path);
        return input.files?.[path] ?? null;
      }),
    readLink: (path) =>
      Effect.sync(() => {
        requested.push(path);
        return input.links?.[path] ?? null;
      }),
    run: (command, args) =>
      Effect.sync(() => {
        const invocation = [command, ...args].join(" ");
        requested.push(invocation);
        return input.commands?.[invocation] ?? null;
      }),
  };
  return { sources, requested };
};

describe("posixQuoteArgv", () => {
  it("leaves plain arguments bare", () => {
    expect(posixQuoteArgv(["npm", "run", "dev", "--port=3000", "./src/a-b_c.ts"])).toBe(
      "npm run dev --port=3000 ./src/a-b_c.ts",
    );
  });

  it("quotes spaces and shell metacharacters", () => {
    expect(posixQuoteArgv(["echo", "two words", "$HOME", "a;b", "*.ts"])).toBe(
      "echo 'two words' '$HOME' 'a;b' '*.ts'",
    );
  });

  it("closes and reopens the quote around a single quote", () => {
    expect(posixQuoteArgv(["echo", "it's"])).toBe(`echo 'it'\\''s'`);
  });

  it("keeps an empty argument as an empty quoted pair", () => {
    expect(posixQuoteArgv(["printf", ""])).toBe("printf ''");
  });
});

describe("readForegroundCommand", () => {
  it.effect("on linux reads NUL-separated argv and the working directory", () =>
    Effect.gen(function* () {
      const { sources, requested } = fakeSources({
        files: { "/proc/4242/cmdline": "node\0/app/vite.js\0--name\0my app\0" },
        links: { "/proc/4242/cwd": "/work/app" },
      });
      const command = yield* readForegroundCommand(4242, "linux", sources);
      expect(command).toEqual({ line: "node /app/vite.js --name 'my app'", cwd: "/work/app" });
      expect(requested).toEqual(["/proc/4242/cmdline", "/proc/4242/cwd"]);
    }),
  );

  it.effect.each([
    {
      program: "python3",
      args: ["manage.py", "runserver"],
      executable: "/usr/bin/python3.15",
      line: "python3 manage.py runserver",
    },
    {
      program: "sh",
      args: ["./dev.sh", "two words"],
      executable: "/usr/bin/bash",
      line: "sh ./dev.sh 'two words'",
    },
    {
      program: "/bin/bash",
      args: ["./dev.sh"],
      executable: "/usr/bin/bash",
      line: "/bin/bash ./dev.sh",
    },
    { program: "node: worker", args: [], executable: "/usr/bin/node", line: null },
  ])(
    "on linux uses the original argv for $program when restorable",
    ({ program, args, executable, line }) =>
      Effect.gen(function* () {
        const cwd = "/work/app";
        const { sources } = fakeSources({
          files: { "/proc/4242/cmdline": [program, ...args, ""].join("\0") },
          links: { "/proc/4242/cwd": cwd, "/proc/4242/exe": executable },
        });
        const command = yield* readForegroundCommand(4242, "linux", sources);
        expect(command).toEqual(line === null ? null : { line, cwd });
      }),
  );

  it.effect("on linux keeps an empty middle argument but drops the trailing terminator", () =>
    Effect.gen(function* () {
      const { sources } = fakeSources({
        files: { "/proc/7/cmdline": "printf\0\0x\0" },
        links: { "/proc/7/cwd": "/tmp" },
      });
      expect(yield* readForegroundCommand(7, "linux", sources)).toEqual({
        line: "printf '' x",
        cwd: "/tmp",
      });
    }),
  );

  it.effect("on linux returns null when the cmdline cannot be read", () =>
    Effect.gen(function* () {
      const { sources } = fakeSources({ links: { "/proc/9/cwd": "/tmp" } });
      expect(yield* readForegroundCommand(9, "linux", sources)).toBeNull();
    }),
  );

  it.effect("on linux returns null for an empty cmdline such as a zombie", () =>
    Effect.gen(function* () {
      const { sources } = fakeSources({
        files: { "/proc/9/cmdline": "" },
        links: { "/proc/9/cwd": "/tmp" },
      });
      expect(yield* readForegroundCommand(9, "linux", sources)).toBeNull();
    }),
  );

  it.effect("on linux returns null when the working directory cannot be read", () =>
    Effect.gen(function* () {
      const { sources } = fakeSources({ files: { "/proc/9/cmdline": "sleep\u0000100\u0000" } });
      expect(yield* readForegroundCommand(9, "linux", sources)).toBeNull();
    }),
  );

  it.effect("returns null when an argument holds a control character", () =>
    Effect.gen(function* () {
      const { sources } = fakeSources({
        files: { "/proc/9/cmdline": "echo\0a\u001b[2Jb\0" },
        links: { "/proc/9/cwd": "/tmp" },
      });
      expect(yield* readForegroundCommand(9, "linux", sources)).toBeNull();
    }),
  );

  it.effect("on darwin reads ps args and the lsof working directory", () =>
    Effect.gen(function* () {
      const { sources, requested } = fakeSources({
        commands: {
          "ps -o args= -p 55": "  npm run dev  \n",
          "lsof -a -p 55 -d cwd -Fn": "p55\nfcwd\nn/Users/me/app\n",
        },
      });
      expect(yield* readForegroundCommand(55, "darwin", sources)).toEqual({
        line: "npm run dev",
        cwd: "/Users/me/app",
      });
      expect(requested).toEqual(["ps -o args= -p 55", "lsof -a -p 55 -d cwd -Fn"]);
    }),
  );

  it.effect("on darwin returns null when ps fails", () =>
    Effect.gen(function* () {
      const { sources } = fakeSources({
        commands: { "lsof -a -p 55 -d cwd -Fn": "p55\nfcwd\nn/Users/me/app\n" },
      });
      expect(yield* readForegroundCommand(55, "darwin", sources)).toBeNull();
    }),
  );

  it.effect("on darwin returns null when lsof reports no directory", () =>
    Effect.gen(function* () {
      const { sources } = fakeSources({
        commands: { "ps -o args= -p 55": "npm run dev\n", "lsof -a -p 55 -d cwd -Fn": "p55\n" },
      });
      expect(yield* readForegroundCommand(55, "darwin", sources)).toBeNull();
    }),
  );

  it.effect("returns null on other platforms without reading anything", () =>
    Effect.gen(function* () {
      const { sources, requested } = fakeSources({});
      expect(yield* readForegroundCommand(1, "win32", sources)).toBeNull();
      expect(requested).toEqual([]);
    }),
  );
});

describe("readProcessCwd", () => {
  it.effect("reads the proc link on linux and lsof on darwin", () =>
    Effect.gen(function* () {
      const linux = fakeSources({ links: { "/proc/3/cwd": "/srv" } });
      expect(yield* readProcessCwd(3, "linux", linux.sources)).toBe("/srv");
      const darwin = fakeSources({
        commands: { "lsof -a -p 3 -d cwd -Fn": "p3\nfcwd\nn/Users/me\n" },
      });
      expect(yield* readProcessCwd(3, "darwin", darwin.sources)).toBe("/Users/me");
    }),
  );

  it.effect("is null on an unsupported platform", () =>
    Effect.gen(function* () {
      expect(yield* readProcessCwd(3, "win32", fakeSources({}).sources)).toBeNull();
    }),
  );
});

describe("restorableTerminalCommand", () => {
  it("accepts a plain line and directory, tabs included", () => {
    expect(restorableTerminalCommand("make\ttest", "/work")).toEqual({
      line: "make\ttest",
      cwd: "/work",
    });
  });

  it("rejects an empty line or directory", () => {
    expect(restorableTerminalCommand("", "/work")).toBeNull();
    expect(restorableTerminalCommand("make", "")).toBeNull();
  });

  it("rejects newline, escape, interrupt and delete in the line", () => {
    for (const control of ["\n", "\u001b", "\u0003", "\u007f", "\r"]) {
      expect(restorableTerminalCommand(`ls${control}`, "/work")).toBeNull();
    }
  });

  it("rejects a control character in the directory", () => {
    expect(restorableTerminalCommand("ls", "/work\n/x")).toBeNull();
  });
});
