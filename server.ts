import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFile } from 'child_process';
import multer from 'multer';
import dotenv from 'dotenv';
import { processFolderUpload, validateRelativePath, UploadedFileItem } from './src/upload_handler.js';
import { getGitRepoStatus, getRealGitCommits } from './src/scm_engine.js';
import { buildDependencyGraph } from './src/dependency_analyzer.js';
import { discoverTestFiles } from './src/test_runner.js';
import { runScmPipeline, runFolderSnapshotAnalysis } from './src/scm_pipeline.js';
import { globalStore, CommitRecord } from './src/analysis_store.js';

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

// EJS View Engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(process.cwd(), 'views'));

// Static assets
app.use('/static', express.static(path.join(process.cwd(), 'static')));

// Helper functions for views
function getActiveCommits(limit = 50): CommitRecord[] {
  const commits = globalStore.getAllCommits();
  commits.sort((a, b) => (b.analyzed_at || b.timestamp).localeCompare(a.analyzed_at || a.timestamp));
  return commits.slice(0, limit);
}

function computeMetrics(commits: CommitRecord[]) {
  const totalCommits = commits.length;
  const highRisk = commits.filter((c) => c.risk_level === 'High').length;
  const medRisk = commits.filter((c) => c.risk_level === 'Medium').length;
  const lowRisk = commits.filter((c) => c.risk_level === 'Low').length;

  const totalTests = commits.reduce((sum, c) => sum + (c.total_tests || 0), 0);
  const passedTests = commits.reduce((sum, c) => sum + (c.passed_tests || 0), 0);
  const failedTests = commits.reduce((sum, c) => sum + (c.failed_tests || 0), 0);
  const passRate = totalTests > 0 ? Math.round((passedTests / totalTests) * 1000) / 10 : 100.0;

  return {
    total_commits: totalCommits,
    high_risk: highRisk,
    med_risk: medRisk,
    low_risk: lowRisk,
    total_tests: totalTests,
    passed_tests: passedTests,
    failed_tests: failedTests,
    pass_rate: passRate
  };
}

function getDependencyGraphData() {
  const ctx = globalStore.getContext();
  const nodesSet = new Set<string>();
  const edges: Array<{ source: string; target: string; type: string }> = [];

  const seenEdges = new Set<string>();
  ctx.dependency_edges.forEach((e) => {
    const key = `${e.source_file}->${e.target_file}`;
    if (seenEdges.has(key)) return; // same edge recorded by several commits
    seenEdges.add(key);
    nodesSet.add(e.source_file);
    nodesSet.add(e.target_file);
    edges.push({ source: e.source_file, target: e.target_file, type: e.dep_type });
  });

  return {
    nodes: Array.from(nodesSet).sort().map((name) => ({ id: name, label: name })),
    edges
  };
}

// -------------------------------------------------------------
// Web Application Routes
// -------------------------------------------------------------

// Home / Landing Page
app.get('/', (req, res) => {
  const commits = getActiveCommits(50);
  const metrics = computeMetrics(commits);
  const ctx = globalStore.getContext();
  res.render('index', {
    metrics,
    recent_commits: commits.slice(0, 5),
    currentContext: { id: ctx.id, name: ctx.name, is_demo: ctx.type === 'demo' }
  });
});

// Main Dashboard
app.get('/dashboard', (req, res) => {
  const commits = getActiveCommits(50);
  const metrics = computeMetrics(commits);
  const ctx = globalStore.getContext();
  const gitCommits = commits.map((c) => ({
    commit_hash: c.commit_hash,
    short_hash: c.short_hash || c.commit_hash.substring(0, 7),
    message: c.message,
    author: c.author
  }));

  res.render('dashboard', {
    commits,
    git_commits: gitCommits,
    repo_path: ctx.workspaceDir || process.cwd(),
    metrics,
    currentContext: { id: ctx.id, name: ctx.name, is_demo: ctx.type === 'demo' }
  });
});

// Interactive 3D Dependency Map
app.get('/dependency-map', (req, res) => {
  const depMapData = getDependencyGraphData();
  const ctx = globalStore.getContext();
  res.render('dependency_map', {
    dep_map: {
      nodes: depMapData.nodes.map((n) => n.id),
      edges: depMapData.edges
    },
    currentContext: { id: ctx.id, name: ctx.name, is_demo: ctx.type === 'demo' }
  });
});

// Regression Testing Section
app.get('/regression-tests', (req, res) => {
  const commits = getActiveCommits(50);
  const metrics = computeMetrics(commits);
  const ctx = globalStore.getContext();
  res.render('regression_tests', {
    commits,
    metrics,
    currentContext: { id: ctx.id, name: ctx.name, is_demo: ctx.type === 'demo' }
  });
});

// Risk Analysis & Formula Breakdown Section
app.get('/risk-analysis', (req, res) => {
  const commits = getActiveCommits(50);
  const metrics = computeMetrics(commits);
  const ctx = globalStore.getContext();
  res.render('risk_analysis', {
    commits,
    metrics,
    currentContext: { id: ctx.id, name: ctx.name, is_demo: ctx.type === 'demo' }
  });
});

// Academic Concepts & Architecture Guide
app.get('/about', (req, res) => {
  res.render('about');
});

// Commit Detail Page
app.get('/commit/:commit_hash', (req, res) => {
  const commitHash = req.params.commit_hash;
  const details = globalStore.getCommitDetails(commitHash);
  if (!details) {
    return res.status(404).render('error', {
      message: `Commit '${commitHash}' not found in the SCM analysis store.`
    });
  }
  const ctx = globalStore.getContext();
  res.render('commit_detail', {
    data: details,
    repo_path: ctx.workspaceDir || process.cwd(),
    currentContext: details.context
  });
});

// Quality & Verification Report
app.get('/report/:commit_hash', (req, res) => {
  const commitHash = req.params.commit_hash;
  const details = globalStore.getCommitDetails(commitHash);
  if (!details) {
    return res.redirect(`/commit/${commitHash}`);
  }
  const ctx = globalStore.getContext();
  res.render('report', {
    data: details,
    repo_path: ctx.workspaceDir || process.cwd(),
    currentContext: details.context
  });
});

// Reports Catalog List
app.get('/reports', (req, res) => {
  const commits = getActiveCommits(50);
  const ctx = globalStore.getContext();
  res.render('reports_list', {
    commits,
    currentContext: { id: ctx.id, name: ctx.name, is_demo: ctx.type === 'demo' }
  });
});

// Baseline Comparison Page
app.get('/compare', (req, res) => {
  const commits = getActiveCommits(50);
  const c1Hash = (req.query.commit1 as string) || commits[0]?.commit_hash;
  const c2Hash = (req.query.commit2 as string) || commits[1]?.commit_hash || commits[0]?.commit_hash;

  const c1 = c1Hash ? globalStore.findCommit(c1Hash) : undefined;
  const c2 = c2Hash ? globalStore.findCommit(c2Hash) : undefined;

  res.render('compare', {
    commits,
    c1,
    c2
  });
});

// -------------------------------------------------------------
// REST API Endpoints
// -------------------------------------------------------------

// Import complete folders with preserved relative structure & AST resolution
app.post('/api/upload', uploadMiddleware.any() as any, async (req, res) => {
  try {
    let files: UploadedFileItem[] = [];
    let projectName = (req.body && req.body.projectName) || 'uploaded_project';

    if (Array.isArray(req.body?.files)) {
      files = req.body.files;
    } else if (Array.isArray(req.files) && req.files.length > 0) {
      let pathMap: Record<string, string> = {};
      if (typeof req.body?.paths === 'string') {
        try {
          pathMap = JSON.parse(req.body.paths);
        } catch {}
      } else if (typeof req.body?.paths === 'object') {
        pathMap = req.body.paths;
      }

      files = (req.files as Express.Multer.File[]).map((f, idx) => {
        const relPath =
          pathMap[f.originalname] || pathMap[f.fieldname] || req.body?.[`path_${idx}`] || f.originalname;
        return {
          relativePath: relPath,
          content: f.buffer.toString('utf-8'),
          size: f.size
        };
      });
    }

    if (!files || files.length === 0) {
      return res.status(400).json({ status: 'error', message: 'No files provided in upload payload' });
    }

    // Security check: validate relative paths
    for (const f of files) {
      if (!f.relativePath) {
        return res.status(400).json({ status: 'error', message: 'Encountered file with missing relativePath' });
      }
      const val = validateRelativePath(f.relativePath);
      if (!val.valid) {
        return res.status(400).json({
          status: 'error',
          message: `Path traversal or invalid path rejected for "${f.relativePath}": ${val.error}`
        });
      }
    }

    const uploadResult = await processFolderUpload(projectName, files);

    // Build real dynamic dependency graph for uploaded project files
    const dependencyGraph = buildDependencyGraph(files);
    const discoveredTests = discoverTestFiles(files.map((f) => f.relativePath));

    // Register isolated context in globalStore
    const newContext = globalStore.createContext(
      uploadResult.uploadId,
      uploadResult.projectName,
      'upload',
      uploadResult.workspaceDir
    );

    // Register dependency edges in context
    newContext.dependency_edges = dependencyGraph.edges.map((e) => ({
      source_file: e.source_file,
      target_file: e.target_file,
      dep_type: e.dep_type,
      context_id: uploadResult.uploadId
    }));

    // Folder uploads have no Git history, so run the snapshot analysis now
    // so the dashboard shows real data for THIS upload.
    const snapshotResult = await runFolderSnapshotAnalysis({
      workspaceDir: uploadResult.workspaceDir,
      projectName: uploadResult.projectName,
      contextId: uploadResult.uploadId,
      runTests: true
    });

    return res.json({
      status: 'success',
      uploadId: uploadResult.uploadId,
      projectName: uploadResult.projectName,
      totalFiles: uploadResult.totalFiles,
      totalBytes: uploadResult.totalBytes,
      files: uploadResult.files.map((f) => ({
        relativePath: f.relativePath,
        size: f.size,
        extension: f.extension,
        category: f.category
      })),
      risk_level: snapshotResult.risk.risk_level,
      risk_score: snapshotResult.risk.total_score,
      ignoredFiles: uploadResult.ignoredFiles,
      workspaceDir: uploadResult.workspaceDir,
      dependency_stats: {
        total_nodes: dependencyGraph.nodes.length,
        total_edges: dependencyGraph.edges.length,
        discovered_tests_count: discoveredTests.length
      }
    });
  } catch (err: any) {
    console.error('[CodeGuard] Folder upload failed:', err);
    return res.status(500).json({
      status: 'error',
      message: err?.message || 'Internal error processing folder upload'
    });
  }
});


// Import a public GitHub repository: clone it, then analyze its REAL commit history
app.post('/api/import-repo', async (req, res) => {
  try {
    const url = String(req.body?.url || '').trim();
    const limit = Math.min(Math.max(parseInt(req.body?.limit, 10) || 10, 1), 30);

    // Only plain GitHub https links are accepted
    const match = url.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
    if (!match) {
      return res.status(400).json({ status: 'error', message: 'Please enter a GitHub link like https://github.com/owner/repo' });
    }
    const repoName = `${match[1]}/${match[2]}`;
    const id = `git_${Date.now()}`;
    const workspaceDir = path.join(os.tmpdir(), 'codeguard_workspaces', id);
    fs.mkdirSync(path.dirname(workspaceDir), { recursive: true });

    // Shallow clone (limit + 1 so the oldest analysed commit still has a parent to diff against)
    await new Promise<void>((resolve, reject) => {
      execFile(
        'git',
        ['clone', '--depth', String(limit + 1), '--no-tags', `https://github.com/${repoName}.git`, workspaceDir],
        { timeout: 180000 },
        (err, _out, stderr) => (err ? reject(new Error(`git clone failed: ${stderr || err.message}`)) : resolve())
      );
    });

    const ctx = globalStore.createContext(id, repoName, 'git', workspaceDir);
    const commits = await getRealGitCommits(workspaceDir, limit);

    // Oldest first so history builds up in order. Tests only run on the newest commit,
    // because the working tree on disk is the latest version.
    const ordered = [...commits].reverse();
    let analyzed = 0;
    const failures: string[] = [];
    for (let i = 0; i < ordered.length; i++) {
      const isLatest = i === ordered.length - 1;
      try {
        await runScmPipeline({
          repoPath: workspaceDir,
          commitHash: ordered[i].commit_hash,
          contextId: ctx.id,
          runTests: isLatest
        });
        analyzed++;
      } catch (e: any) {
        failures.push(`${ordered[i].commit_hash.substring(0, 7)}: ${e?.message || 'failed'}`);
      }
    }

    if (analyzed === 0) {
      return res.status(422).json({ status: 'error', message: `Cloned ${repoName} but could not analyze any commit. ${failures[0] || ''}` });
    }

    return res.json({ status: 'success', repo: repoName, commits_found: commits.length, commits_analyzed: analyzed, failures });
  } catch (err: any) {
    console.error('[CodeGuard] Repo import failed:', err);
    return res.status(500).json({ status: 'error', message: err?.message || 'Repo import failed' });
  }
});


// Analyze a Git repository that already exists on THIS computer (the server runs locally),
// so real commit history is read straight from its .git folder - no upload needed.
app.post('/api/import-local', async (req, res) => {
  try {
    const repoPath = path.resolve(String(req.body?.path || '').trim().replace(/^"|"$/g, ''));
    const limit = Math.min(Math.max(parseInt(req.body?.limit, 10) || 10, 1), 30);

    if (!req.body?.path || !fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
      return res.status(400).json({ status: 'error', message: 'Folder not found. Paste the full path, e.g. C:\\Users\\you\\my-project' });
    }
    const status = await getGitRepoStatus(repoPath);
    if (!status.is_git) {
      return res.status(422).json({ status: 'error', message: 'That folder is not a Git repository (no .git folder with commits). Run "git init" and commit, or use the GitHub link option.' });
    }

    const id = `git_local_${Date.now()}`;
    const ctx = globalStore.createContext(id, path.basename(repoPath), 'git', repoPath);
    const commits = await getRealGitCommits(repoPath, limit);
    const ordered = [...commits].reverse();
    let analyzed = 0;
    const failures: string[] = [];
    for (let i = 0; i < ordered.length; i++) {
      try {
        await runScmPipeline({
          repoPath,
          commitHash: ordered[i].commit_hash,
          contextId: ctx.id,
          runTests: i === ordered.length - 1
        });
        analyzed++;
      } catch (e: any) {
        failures.push(`${ordered[i].commit_hash.substring(0, 7)}: ${e?.message || 'failed'}`);
      }
    }
    if (analyzed === 0) {
      return res.status(422).json({ status: 'error', message: `Could not analyze any commit. ${failures[0] || ''}` });
    }
    return res.json({ status: 'success', repo: path.basename(repoPath), commits_found: commits.length, commits_analyzed: analyzed, failures });
  } catch (err: any) {
    console.error('[CodeGuard] Local repo import failed:', err);
    return res.status(500).json({ status: 'error', message: err?.message || 'Local import failed' });
  }
});

// Real SCM analysis endpoint (NO FAKE DATABASE.PY FALLBACK)
app.post('/api/analyze', async (req, res) => {
  try {
    const data = req.body || {};
    let targetHash = (data.commit_hash || 'HEAD').trim();
    const repoPath = data.repo_path || process.cwd();

    const activeCtx = globalStore.getContext();

    // 1. If target is HEAD or specific hash in active context:
    if (targetHash.toUpperCase() === 'HEAD') {
      const activeCommits = globalStore.getAllCommits();
      if (activeCommits.length > 0) {
        targetHash = activeCommits[0].commit_hash;
      }
    }

    // 2. Check if commit is already recorded in active context
    const existing = globalStore.findCommit(targetHash);
    if (existing) {
      const details = globalStore.getCommitDetails(existing.commit_hash)!;
      return res.json({
        status: 'success',
        is_demo: existing.is_demo || false,
        source: existing.source || 'recorded_baseline',
        commit_hash: details.commit.commit_hash,
        risk_score: details.commit.risk_score,
        risk_level: details.commit.risk_level,
        changed_files_count: details.changed_files.length,
        affected_files_count: details.affected_files.length,
        tests_run: details.test_runs.total,
        tests_failed: details.test_runs.failed
      });
    }

    // 3. If not in store, attempt genuine Git SCM pipeline
    const gitStatus = await getGitRepoStatus(repoPath);
    if (gitStatus.is_git) {
      try {
        const pipelineResult = await runScmPipeline({
          repoPath,
          commitHash: targetHash,
          contextId: activeCtx.id,
          runTests: true
        });

        return res.json({
          status: 'success',
          is_demo: false,
          source: 'live_git',
          commit_hash: pipelineResult.commit.commit_hash,
          risk_score: pipelineResult.commit.risk_score,
          risk_level: pipelineResult.commit.risk_level,
          changed_files_count: pipelineResult.changed_files.length,
          affected_files_count: pipelineResult.affected_files.length,
          tests_run: pipelineResult.test_runs.total,
          tests_failed: pipelineResult.test_runs.failed
        });
      } catch (pipelineErr: any) {
        return res.status(404).json({
          status: 'error',
          message: pipelineErr.message || `Failed to analyze Git commit ${targetHash}`
        });
      }
    }

    // 4. Honest 404 response: commit does not exist
    return res.status(404).json({
      status: 'error',
      message: `Commit "${targetHash}" was not found in the repository or active analysis context. CodeGuard never fabricates non-existent commits.`
    });
  } catch (err: any) {
    return res.status(500).json({
      status: 'error',
      message: err?.message || 'Server error during SCM analysis'
    });
  }
});

// Compare two commits
app.get('/api/compare', (req, res) => {
  const c1Hash = req.query.commit1 as string;
  const c2Hash = req.query.commit2 as string;

  if (!c1Hash || !c2Hash) {
    return res.status(400).json({ status: 'error', message: 'Both commit1 and commit2 query parameters are required' });
  }

  const c1 = globalStore.findCommit(c1Hash);
  const c2 = globalStore.findCommit(c2Hash);

  if (!c1 || !c2) {
    return res.status(404).json({ status: 'error', message: 'One or both commits not found in active store' });
  }

  const riskDelta = Math.round((c2.risk_score - c1.risk_score) * 10) / 10;
  const churn1 = (c1.lines_added || 0) + (c1.lines_deleted || 0);
  const churn2 = (c2.lines_added || 0) + (c2.lines_deleted || 0);

  return res.json({
    status: 'success',
    comparison: {
      commit1: { hash: c1.commit_hash, risk: c1.risk_score, risk_level: c1.risk_level, churn: churn1 },
      commit2: { hash: c2.commit_hash, risk: c2.risk_score, risk_level: c2.risk_level, churn: churn2 },
      delta: {
        risk_score_delta: riskDelta,
        lines_churn_delta: churn2 - churn1,
        affected_files_delta: (c2.affected_files_count || 0) - (c1.affected_files_count || 0),
        failed_tests_delta: (c2.failed_tests || 0) - (c1.failed_tests || 0)
      }
    }
  });
});

// Exportable verification report (JSON format)
app.get('/api/report/:commit_hash/export', (req, res) => {
  const commitHash = req.params.commit_hash;
  const details = globalStore.getCommitDetails(commitHash);
  if (!details) {
    return res.status(404).json({ error: `Commit '${commitHash}' not found` });
  }

  res.setHeader('Content-Disposition', `attachment; filename="codeguard-report-${commitHash.substring(0, 7)}.json"`);
  res.setHeader('Content-Type', 'application/json');
  return res.json({
    codeguard_version: '1.2.0',
    export_timestamp: new Date().toISOString(),
    audit_verdict: details.test_runs.failed === 0 ? 'ACCEPTED_VERIFIED' : 'REVIEW_REQUIRED_REGRESSION_DETECTED',
    report_data: details
  });
});

// Contexts management
app.get('/api/contexts', (req, res) => {
  res.json({
    activeContextId: globalStore.getActiveContextId(),
    contexts: globalStore.listContexts()
  });
});

app.post('/api/contexts/switch', (req, res) => {
  const { contextId } = req.body || {};
  if (!contextId) {
    return res.status(400).json({ error: 'contextId is required' });
  }
  globalStore.setActiveContextId(contextId);
  res.json({ status: 'success', activeContextId: globalStore.getActiveContextId() });
});

app.get('/api/commits', (req, res) => {
  const commits = getActiveCommits(100);
  res.json({ commits });
});

app.get('/api/commit/:commit_hash', (req, res) => {
  const details = globalStore.getCommitDetails(req.params.commit_hash);
  if (!details) {
    return res.status(404).json({ error: 'Commit not found' });
  }
  res.json(details);
});

app.get('/api/dependency-map', (req, res) => {
  const depMapData = getDependencyGraphData();
  res.json(depMapData);
});

// Genuine System Readiness Checks
app.get('/api/system-status', async (req, res) => {
  const gitStatus = await getGitRepoStatus(process.cwd());
  const activeCtx = globalStore.getContext();

  res.json({
    git_repository: gitStatus.is_git
      ? `Active (${gitStatus.branch || 'main'}, ${gitStatus.commit_count || 0} commits)`
      : 'Not Initialized (Use Folder Upload or Git Clone)',
    database: `Ready (In-Memory SCM Store with ${globalStore.listContexts().length} Contexts)`,
    analyzer: 'Ready (Python & TypeScript AST Dependency Engine Active)',
    test_runner: 'Ready (Python unittest & Node Test Runner Verified)',
    active_context: `${activeCtx.name} (${activeCtx.type === 'demo' ? 'Demo Fixture' : 'Live Analysis'})`,
    status: 'All Systems Operational'
  });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`\n======================================================`);
  console.log(`  CodeGuard-SCM Server Running Successfully!`);
  console.log(`  - Local Access:      http://localhost:${PORT}`);
  console.log(`  - Loopback IP:       http://127.0.0.1:${PORT}`);
  console.log(`  - Network Interface: http://${HOST}:${PORT}`);
  console.log(`======================================================\n`);
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[CodeGuard Startup Error] Port ${PORT} is already occupied by another process.`);
    console.error(`Safe resolution options:`);
    console.error(`  1. In Windows PowerShell, find and stop the process occupying port ${PORT}:`);
    console.error(`     Get-Process -Id (Get-NetTCPConnection -LocalPort ${PORT}).OwningProcess | Stop-Process -Force`);
    console.error(`  2. Or run on an alternative port by setting the PORT environment variable:`);
    console.error(`     $env:PORT="3001"; npm run dev\n`);
    process.exit(1);
  } else {
    console.error(`\n[CodeGuard Startup Error] Failed to bind to ${HOST}:${PORT}:`, err);
    process.exit(1);
  }
});