"""Validate uploads and activate a complete local training run."""
import csv
import hashlib
import io
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import RLock, Thread
from uuid import uuid4

from core import BASE, USER_KEYS
from engine import Recommender
from train import prepare_csv, synthetic

MAX_UPLOAD_BYTES = 32 * 1024 * 1024
EPOCHS = 65


def template_csv():
    stream = io.StringIO()
    writer = csv.writer(stream)
    writer.writerow(['user_id', 'pet_id', 'score', *USER_KEYS, 'source'])
    for user, profile, pet, score in synthetic(24, 2026):
        values = [str(profile[key]).lower() if isinstance(profile[key], bool) else profile[key] for key in USER_KEYS]
        writer.writerow([f'demo_{user}', pet['id'], round(score, 4), *values, 'synthetic_template'])
    return stream.getvalue()


class TrainingLab:
    def __init__(self, root, initial=None):
        self.root = Path(root)
        self.lock = RLock()
        self.jobs = {}
        self.current = initial if initial is not None else Recommender()
        if initial is None:
            try:
                active = json.loads((self.root / 'active.json').read_text(encoding='utf-8'))
                if not re.fullmatch('[0-9a-f]{32}', active['id']):
                    raise ValueError('invalid model ID')
                self.current = self._load(active)
            except (OSError, ValueError, KeyError, TypeError):
                pass

    def _load(self, job):
        path = self.root / job['id']
        candidate = Recommender(path / 'model.pt')
        if (candidate.model is None or candidate.metrics is None or
                candidate.dataset_sha256 != job['dataset_sha256']):
            raise ValueError('训练产物校验失败')
        candidate.version = job['id'][:12]
        candidate.dataset_name = job['dataset_name']
        return candidate

    def snapshot(self):
        with self.lock:
            return self.current

    def preview(self, owner, upload):
        self.root.mkdir(parents=True, exist_ok=True)
        job_id = uuid4().hex
        name = upload.filename.replace('\\', '/').rsplit('/', 1)[-1][:120]
        with TemporaryDirectory(dir=self.root) as staging:
            path = Path(staging) / 'ratings.csv'
            upload.save(path)
            rows, groups, sources, explicit = prepare_csv(path, max_rows=75000)
            by_split = {part: {'rows': len(group), 'users': len({row[0] for row in group})}
                        for part, group in groups.items()}
            sample = []
            for part, group in groups.items():
                for user, _, pet, score in group[:4]:
                    sample.append({'user_id': user, 'pet': pet['display_name'], 'score': score, 'split': part})
            job = {
                'id': job_id, 'dataset_name': name, 'dataset_sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                'rows': len(rows), 'users': len({row[0] for row in rows}),
                'pet_types': len({row[2]['id'] for row in rows}),
                'sources': sorted(sources), 'split': by_split, 'explicit_split': explicit,
                'sample': sample, 'status': 'ready', 'epoch': 0, 'epochs': EPOCHS,
            }
            with self.lock:
                incoming = self.root / job_id
                incoming.mkdir()
                path.replace(incoming / 'ratings.csv')
                for previous_id, previous in list(self.jobs.items()):
                    if previous['owner'] == owner and previous['status'] == 'ready':
                        self.jobs.pop(previous_id)
                        previous_path = self.root / previous_id
                        try:
                            (previous_path / 'ratings.csv').unlink()
                            previous_path.rmdir()
                        except OSError:
                            pass
                self.jobs[job_id] = dict(job, owner=owner)
        return job

    def get(self, owner, job_id):
        with self.lock:
            job = self.jobs.get(job_id)
            if job and job['owner'] == owner:
                return {key: value for key, value in job.items() if key != 'owner'}
            return None

    def start(self, owner, job_id):
        with self.lock:
            job = self.get(owner, job_id)
            if job is None:
                raise LookupError('本会话没有这次数据预览')
            if job['status'] in ('running', 'done'):
                return job
            if any(candidate['status'] == 'running' for candidate in self.jobs.values()):
                raise RuntimeError('当前有训练在进行，请在完成后再启动')
            path = self.root / job_id / 'ratings.csv'
            if hashlib.sha256(path.read_bytes()).hexdigest() != job['dataset_sha256']:
                raise ValueError('CSV 已变化，请重新上传并预览')
            self.jobs[job_id].update(status='running', epoch=0, error=None)
            Thread(target=self._train, args=(job_id,), daemon=True).start()
            return self.get(owner, job_id)

    def _train(self, job_id):
        directory = (self.root / job_id).resolve()
        try:
            command = [sys.executable, '-u', str(BASE / 'train.py'), '--csv', str(directory / 'ratings.csv'),
                       '--data-source', 'upload', '--epochs', str(EPOCHS), '--out', str(directory)]
            with (directory / 'training.log').open('w', encoding='utf-8') as log:
                with subprocess.Popen(command, cwd=BASE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                      text=True, encoding='utf-8', env={**os.environ, 'PYTHONUTF8': '1'},
                                      creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0)) as process:
                    for line in process.stdout:
                        log.write(line)
                        if (match := re.match(r'epoch=(\d+) ', line)):
                            with self.lock:
                                self.jobs[job_id]['epoch'] = int(match[1])
                    if process.wait():
                        raise RuntimeError('train.py failed')
            with self.lock:
                job = self.jobs[job_id]
                active = {key: job[key] for key in ('id', 'dataset_name', 'dataset_sha256')}
                candidate = self._load(active)
                staged = directory / 'active.tmp'
                staged.write_text(json.dumps(active, ensure_ascii=False), encoding='utf-8')
                staged.replace(self.root / 'active.json')
                self.current = candidate
                job.update(status='done', model_version=candidate.version)
        except (OSError, ValueError, RuntimeError):
            with self.lock:
                self.jobs[job_id].update(status='failed', error='训练未完成，当前模型仍可使用。请检查数据后重试。')
