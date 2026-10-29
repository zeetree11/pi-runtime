#!/usr/bin/env python3
"""Terminal-task benchmark runner (host-orchestrated).

Mirrors the topology that makes an eval trustworthy:

    host (python)      starts the task container, runs the agent, runs the verifier
    agent container    pi + the bridge MCP server; sees only docker exec, never the host key file
    task container     the thing being tested; the agent reaches it only through the bridge

Why the agent is not installed inside the task container: the task's own code runs there, and an
API key in that sandbox is an API key the task can steal. The bridge keeps credentials out.

Each task directory holds:
    meta.json     {id, image, instruction, setup?, tests}
    setup.sh      optional, runs inside the container before the agent starts
    tests.sh      the verifier: exit 0 means the task is solved

Output: bench/terminal/results/<id>.json plus a summary line per task.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def sh(cmd, timeout=600, input_text=None):
    return subprocess.run(
        cmd,
        shell=isinstance(cmd, str),
        capture_output=True,
        text=True,
        timeout=timeout,
        input=input_text,
    )


def container_running(name):
    out = sh(["docker", "inspect", "-f", "{{.State.Running}}", name])
    return out.returncode == 0 and out.stdout.strip() == "true"


def start_task_container(name, image):
    sh(["docker", "rm", "-f", name])
    run = sh(["docker", "run", "-d", "--name", name, image, "sleep", "infinity"], timeout=900)
    if run.returncode != 0:
        raise RuntimeError(f"启动任务容器失败：{run.stderr.strip()[:400]}")


def run_in_container(name, script_path, timeout=300):
    script = Path(script_path).read_text(encoding="utf-8-sig").lstrip("\ufeff")
    return sh(["docker", "exec", "-i", name, "bash", "-s"], timeout=timeout, input_text=script)


def write_mcp_config(home: Path, task_container: str):
    agent_dir = home / ".pi" / "agent"
    agent_dir.mkdir(parents=True, exist_ok=True)
    config = {
        "mcpServers": {
            "task": {
                "command": "node",
                "args": ["/app/mcp/task-exec-server.mjs"],
                "env": {"PI_RT_TASK_CONTAINER": task_container},
                "exposure": "direct",
                "description": "在任务沙箱容器里执行命令、读写文件",
            }
        }
    }
    (agent_dir / "mcp.json").write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")


def run_agent(meta, task_container, workdir: Path, timeout_min: int):
    """Run pi in its own container with the docker socket mounted, so the bridge can exec."""
    home = workdir / "home"
    home.mkdir(parents=True, exist_ok=True)
    write_mcp_config(home, task_container)

    env_file = Path("/srv/pi-rt/env/pi-rt.env")
    key = ""
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            if line.startswith("DEEPSEEK_API_KEY="):
                key = line.split("=", 1)[1].strip()

    cmd = [
        "docker", "run", "--rm",
        "--name", f"{task_container}-agent",
        "-v", f"{ROOT}:/app:ro",
        "-v", f"{home}:/root",
        "-v", "/var/run/docker.sock:/var/run/docker.sock",
        "-v", "/usr/bin/docker:/usr/bin/docker:ro",
        "-e", "HOME=/root",
        "-e", f"DEEPSEEK_API_KEY={key}",
        "-e", "PI_RT_TASK_CONTAINER=" + task_container,
        "node:24",
        "node", "/app/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
        "-p", meta["instruction"],
        "--model", meta.get("model", "deepseek/deepseek-chat"),
        "--tools", "mcp__task__*",
        "--no-approve",
        "--no-session",
    ]
    started = time.time()
    proc = sh(cmd, timeout=timeout_min * 60)
    return {
        "stdout": proc.stdout[-8000:],
        "stderr": proc.stderr[-4000:],
        "code": proc.returncode,
        "seconds": round(time.time() - started, 1),
    }


def verify(name, tests_path):
    result = run_in_container(name, tests_path, timeout=600)
    return {
        "reward": 1 if result.returncode == 0 else 0,
        "output": (result.stdout + result.stderr)[-2000:],
        "code": result.returncode,
    }


def run_task(task_dir: Path, timeout_min: int, keep: bool):
    meta = json.loads((task_dir / "meta.json").read_text(encoding="utf-8-sig").lstrip("\ufeff"))
    task_id = meta["id"]
    container = f"tb-{task_id}"
    workdir = ROOT / "bench" / "terminal" / "results" / task_id
    shutil.rmtree(workdir, ignore_errors=True)
    workdir.mkdir(parents=True, exist_ok=True)

    print(f"== {task_id} ({meta['image']}) ==", flush=True)
    start_task_container(container, meta["image"])
    try:
        setup = task_dir / "setup.sh"
        if setup.exists():
            result = run_in_container(container, setup)
            if result.returncode != 0:
                print(f"   setup 失败：{(result.stdout + result.stderr)[-300:]}")

        agent = run_agent(meta, container, workdir, timeout_min)
        check = verify(container, task_dir / "tests.sh")
        record = {
            "id": task_id,
            "image": meta["image"],
            "reward": check["reward"],
            "agent_seconds": agent["seconds"],
            "agent_exit": agent["code"],
            "tests_output": check["output"],
            "agent_tail": agent["stdout"][-1500:],
            "when": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        }
        (workdir / "result.json").write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"   结果 reward={record['reward']} 耗时={record['agent_seconds']}s", flush=True)
        return record
    finally:
        if not keep:
            sh(["docker", "rm", "-f", container])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tasks", nargs="*", default=None, help="任务目录，默认跑 tasks/ 下全部")
    parser.add_argument("--timeout", type=int, default=12, help="单任务分钟上限")
    parser.add_argument("--keep", action="store_true", help="保留容器便于调试")
    args = parser.parse_args()

    tasks_root = ROOT / "bench" / "terminal" / "tasks"
    if args.tasks:
        task_dirs = [Path(item) if Path(item).is_absolute() else tasks_root / item for item in args.tasks]
    else:
        task_dirs = sorted(p for p in tasks_root.iterdir() if (p / "meta.json").exists())

    records = []
    for task_dir in task_dirs:
        try:
            records.append(run_task(task_dir, args.timeout, args.keep))
        except Exception as error:  # noqa: BLE001 - one bad task must not hide the others
            print(f"   失败：{error}", flush=True)
            records.append({"id": task_dir.name, "reward": 0, "error": str(error)[:400]})

    passed = sum(1 for record in records if record.get("reward") == 1)
    summary = {
        "when": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "tasks": len(records),
        "passed": passed,
        "rate": round(passed / len(records), 4) if records else 0,
        "results": records,
    }
    out = ROOT / "bench" / "terminal" / "results" / "summary.json"
    out.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n通过 {passed}/{len(records)}（{summary['rate'] * 100:.1f}%）→ {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
