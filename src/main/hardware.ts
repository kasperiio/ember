import os from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { Hardware, ModelRecommendation, OllamaModel } from '../shared/types'

const run = promisify(execFile)

export async function scanHardware(): Promise<Hardware> {
  const cpus = os.cpus()
  const hw: Hardware = {
    cpu: cpus[0]?.model?.trim() ?? 'Unknown CPU',
    cores: cpus.length,
    ramGb: Math.round(os.totalmem() / 1024 ** 3),
    gpus: []
  }
  // NVIDIA via nvidia-smi
  try {
    const { stdout } = await run('nvidia-smi', ['--query-gpu=name,memory.total,memory.used', '--format=csv,noheader,nounits'], { timeout: 5000 })
    for (const line of stdout.trim().split('\n')) {
      const [name, total, used] = line.split(',').map((s) => s.trim())
      if (name) hw.gpus.push({ name, vramGb: +(Number(total) / 1024).toFixed(1), usedGb: +(Number(used) / 1024).toFixed(1), vendor: 'nvidia' })
    }
  } catch {
    // no nvidia-smi
  }
  // Fallback: any GPU via PowerShell CIM (VRAM reported is unreliable above 4GB; used only when nvidia-smi fails)
  if (hw.gpus.length === 0 && process.platform === 'win32') {
    try {
      const { stdout } = await run(
        'powershell',
        ['-NoProfile', '-Command', 'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json'],
        { timeout: 8000 }
      )
      const arr = JSON.parse(stdout)
      for (const g of Array.isArray(arr) ? arr : [arr]) {
        const name: string = g.Name ?? 'GPU'
        const vendor = /nvidia/i.test(name) ? 'nvidia' : /amd|radeon/i.test(name) ? 'amd' : /intel/i.test(name) ? 'intel' : 'unknown'
        hw.gpus.push({ name, vramGb: +((g.AdapterRAM ?? 0) / 1024 ** 3).toFixed(1), usedGb: 0, vendor })
      }
    } catch {
      // ignore
    }
  }
  return hw
}

// Curated catalogue of models worth recommending. Sizes are approximate download sizes (GB).
const CATALOGUE: Omit<ModelRecommendation, 'fits' | 'why'>[] = [
  { name: 'Qwen3 0.6B', tag: 'qwen3:0.6b', sizeGb: 0.5, tools: true, vision: false, thinking: true },
  { name: 'Qwen3 1.7B', tag: 'qwen3:1.7b', sizeGb: 1.4, tools: true, vision: false, thinking: true },
  { name: 'Qwen3 4B', tag: 'qwen3:4b', sizeGb: 2.6, tools: true, vision: false, thinking: true },
  { name: 'Qwen3 8B', tag: 'qwen3:8b', sizeGb: 5.2, tools: true, vision: false, thinking: true },
  { name: 'Qwen3 14B', tag: 'qwen3:14b', sizeGb: 9.3, tools: true, vision: false, thinking: true },
  { name: 'Qwen3 30B (MoE, fast)', tag: 'qwen3:30b', sizeGb: 19, tools: true, vision: false, thinking: true },
  { name: 'Qwen3 32B', tag: 'qwen3:32b', sizeGb: 20, tools: true, vision: false, thinking: true },
  { name: 'Qwen3-Coder 30B', tag: 'qwen3-coder:30b', sizeGb: 19, tools: true, vision: false, thinking: false },
  { name: 'Gemma 3 4B (vision)', tag: 'gemma3:4b', sizeGb: 3.3, tools: false, vision: true, thinking: false },
  { name: 'Gemma 3 12B (vision)', tag: 'gemma3:12b', sizeGb: 8.1, tools: false, vision: true, thinking: false },
  { name: 'Gemma 3 27B (vision)', tag: 'gemma3:27b', sizeGb: 17, tools: false, vision: true, thinking: false },
  { name: 'Llama 3.1 8B', tag: 'llama3.1:8b', sizeGb: 4.9, tools: true, vision: false, thinking: false },
  { name: 'Llama 3.2 Vision 11B', tag: 'llama3.2-vision:11b', sizeGb: 7.8, tools: false, vision: true, thinking: false },
  { name: 'DeepSeek-R1 8B', tag: 'deepseek-r1:8b', sizeGb: 5.2, tools: false, vision: false, thinking: true },
  { name: 'DeepSeek-R1 14B', tag: 'deepseek-r1:14b', sizeGb: 9, tools: false, vision: false, thinking: true },
  { name: 'Devstral 24B (coding agent)', tag: 'devstral:24b', sizeGb: 14, tools: true, vision: false, thinking: false },
  { name: 'Mistral Small 3.2 24B', tag: 'mistral-small3.2:24b', sizeGb: 15, tools: true, vision: true, thinking: false },
  { name: 'GPT-OSS 20B', tag: 'gpt-oss:20b', sizeGb: 14, tools: true, vision: false, thinking: true },
  { name: 'GPT-OSS 120B', tag: 'gpt-oss:120b', sizeGb: 65, tools: true, vision: false, thinking: true }
]

export function recommend(hw: Hardware, installed: OllamaModel[]): ModelRecommendation[] {
  const vram = Math.max(0, ...hw.gpus.map((g) => g.vramGb))
  const ram = hw.ramGb
  const have = new Set(installed.map((m) => m.name.split(':')[0] + ':' + (m.name.split(':')[1] ?? 'latest')))
  return CATALOGUE.map((m) => {
    // Rough rule: a model needs ~1.2x its file size in memory, plus context.
    const need = m.sizeGb * 1.2 + 1
    const fits: ModelRecommendation['fits'] = need <= vram ? 'gpu' : need <= ram * 0.7 ? 'ram' : 'no'
    const why =
      fits === 'gpu'
        ? `Fits in your ${vram} GB of GPU memory - fast.`
        : fits === 'ram'
          ? `Too big for the GPU (${vram} GB); runs on CPU + ${ram} GB RAM - slow.`
          : `Needs ~${need.toFixed(0)} GB; more than this PC has.`
    return { ...m, fits, why, name: have.has(m.tag) ? m.name + ' (installed)' : m.name }
  }).sort((a, b) => ({ gpu: 0, ram: 1, no: 2 })[a.fits] - ({ gpu: 0, ram: 1, no: 2 })[b.fits] || b.sizeGb - a.sizeGb)
}

export async function installOllama(onLog: (s: string) => void): Promise<boolean> {
  if (process.platform !== 'win32') return false
  try {
    onLog('Installing Ollama with winget...')
    await new Promise<void>((res, rej) => {
      const p = execFile('winget', ['install', '-e', '--id', 'Ollama.Ollama', '--accept-source-agreements', '--accept-package-agreements'], { timeout: 600000 })
      p.stdout?.on('data', (d) => onLog(String(d)))
      p.stderr?.on('data', (d) => onLog(String(d)))
      p.on('exit', (c) => (c === 0 ? res() : rej(new Error('winget exited ' + c))))
      p.on('error', rej)
    })
    return true
  } catch (e: any) {
    onLog('Install failed: ' + e.message + '\nDownload Ollama manually from https://ollama.com/download')
    return false
  }
}
