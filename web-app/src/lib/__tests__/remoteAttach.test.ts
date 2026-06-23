import { describe, it, expect } from 'vitest'
import {
  classifyRemoteFile,
  getExtension,
  mimeTypeFor,
  filterAndSortEntries,
  rankEntry,
  shouldTriggerRemotePicker,
  stripTrailingTilde,
} from '../remoteAttach'
import type { RemoteFileEntry } from '@/services/remote-files/types'

const file = (path: string, size = 0): RemoteFileEntry => {
  const name = path.split(/[\\/]/).pop() || path
  return { name, path, isDir: false, size }
}
const dir = (path: string): RemoteFileEntry => {
  const name = path.split(/[\\/]/).pop() || path
  return { name, path, isDir: true, size: 0 }
}

describe('getExtension', () => {
  it('returns lowercased extension without dot', () => {
    expect(getExtension('photo.PNG')).toBe('png')
    expect(getExtension('archive.tar.gz')).toBe('gz')
  })
  it('returns empty string for no extension or trailing dot', () => {
    expect(getExtension('Makefile')).toBe('')
    expect(getExtension('README.')).toBe('')
  })
})

describe('classifyRemoteFile', () => {
  it('classifies images', () => {
    expect(classifyRemoteFile('a.jpg')).toBe('image')
    expect(classifyRemoteFile('a.JPEG')).toBe('image')
    expect(classifyRemoteFile('a.png')).toBe('image')
  })
  it('classifies audio', () => {
    expect(classifyRemoteFile('clip.wav')).toBe('audio')
    expect(classifyRemoteFile('clip.MP3')).toBe('audio')
  })
  it('falls back to document for everything else', () => {
    expect(classifyRemoteFile('spec.pdf')).toBe('document')
    expect(classifyRemoteFile('index.ts')).toBe('document')
    expect(classifyRemoteFile('Makefile')).toBe('document')
    expect(classifyRemoteFile('noext')).toBe('document')
  })
})

describe('mimeTypeFor', () => {
  it('maps image/audio extensions to MIME types', () => {
    expect(mimeTypeFor('a.jpg')).toBe('image/jpeg')
    expect(mimeTypeFor('a.jpeg')).toBe('image/jpeg')
    expect(mimeTypeFor('a.png')).toBe('image/png')
    expect(mimeTypeFor('a.wav')).toBe('audio/wav')
    expect(mimeTypeFor('a.mp3')).toBe('audio/mpeg')
  })
  it('returns empty string for documents (path-based, no MIME needed)', () => {
    expect(mimeTypeFor('a.pdf')).toBe('')
    expect(mimeTypeFor('a.ts')).toBe('')
  })
})

describe('rankEntry', () => {
  it('rejects non-matching entries', () => {
    expect(rankEntry(file('/x/foo.txt'), 'bar')).toBeNull()
  })
  it('ranks exact name match best', () => {
    const exact = rankEntry(file('/a/report.pdf'), 'report.pdf')!
    const prefix = rankEntry(file('/a/report.pdf'), 'rep')!
    expect(exact).toBeLessThan(prefix)
  })
  it('ranks name starts-with better than name contains', () => {
    const starts = rankEntry(file('/a/report.pdf'), 'rep')!
    const contains = rankEntry(file('/a/my-report.pdf'), 'rep')!
    expect(starts).toBeLessThan(contains)
  })
  it('ranks name contains better than path contains', () => {
    const nameContains = rankEntry(file('/a/report.pdf'), 'port')!
    const pathContains = rankEntry(file('/a/report.pdf'), 'a/')!
    expect(nameContains).toBeLessThan(pathContains)
  })
  it('prefers files over directories at the same bucket', () => {
    // Both land in the "name starts with" bucket (neither is an exact match);
    // the file must outrank the directory.
    const d = rankEntry(dir('/a/reports'), 'report')!
    const f = rankEntry(file('/a/report.txt'), 'report')!
    expect(f).toBeLessThan(d)
  })
  it('exact name match on a dir still beats starts-with on a file', () => {
    // "report" is an exact name match for the dir, but only a starts-with for
    // the file — the exact-match bucket always wins, even over the file bias.
    const d = rankEntry(dir('/a/report'), 'report')!
    const f = rankEntry(file('/a/report.txt'), 'report')!
    expect(d).toBeLessThan(f)
  })
  it('empty query ranks files ahead of directories', () => {
    expect(rankEntry(file('/a.txt'), '')).toBeLessThan(
      rankEntry(dir('/sub'), '')!
    )
  })
})

describe('filterAndSortEntries', () => {
  const entries: RemoteFileEntry[] = [
    file('/proj/src/index.ts', 100),
    file('/proj/src/utils.ts', 50),
    file('/proj/README.md', 1000),
    dir('/proj/src'),
    dir('/proj/tests'),
    file('/proj/report.pdf', 5000),
  ]

  it('returns files-first when query is empty', () => {
    const out = filterAndSortEntries(entries, '')
    // All files should appear before any directory.
    const firstDirIdx = out.findIndex((e) => e.isDir)
    const lastFileIdx = out.map((e) => !e.isDir).lastIndexOf(true)
    expect(firstDirIdx).toBeGreaterThan(lastFileIdx)
  })

  it('narrows by substring and ranks files above name-matched dirs', () => {
    const out = filterAndSortEntries(entries, 'ts')
    // index.ts + utils.ts match by name (file, bucket 2); "tests" matches by
    // name (dir, bucket 2 + dir penalty). Note "/proj/src" does NOT contain
    // "ts" so the src dir is correctly absent from the results.
    expect(out.map((e) => e.name)).toEqual([
      'index.ts',
      'utils.ts',
      'tests',
    ])
  })

  it('falls back to path-only matches when no name matches', () => {
    // Query 'proj' is in every path but in no name — every entry should match
    // via the path-contains bucket (bucket 3).
    const out = filterAndSortEntries(entries, 'proj')
    expect(out).toHaveLength(entries.length)
  })

  it('is case-insensitive', () => {
    const out = filterAndSortEntries(entries, 'README')
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('README.md')
  })

  it('returns empty array when nothing matches', () => {
    expect(filterAndSortEntries(entries, 'zzzz')).toEqual([])
  })

  it('caps to the requested limit', () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      file(`/p/f${i}.txt`, 1)
    )
    expect(filterAndSortEntries(many, '', 10)).toHaveLength(10)
  })

  it('exact name match outranks partial matches across many entries', () => {
    const many: RemoteFileEntry[] = [
      file('/a/my-report-v2.pdf'),
      file('/a/report.pdf'),
      file('/a/report-final.pdf'),
    ]
    const out = filterAndSortEntries(many, 'report.pdf')
    expect(out[0].path).toBe('/a/report.pdf')
  })
})

describe('shouldTriggerRemotePicker', () => {
  it('triggers when prompt ends with ~ and picker is closed', () => {
    expect(shouldTriggerRemotePicker('hello~', false)).toBe(true)
    expect(shouldTriggerRemotePicker('~', false)).toBe(true)
  })
  it('does not trigger when the picker is already open', () => {
    // Guards against re-summoning while the user types in the picker.
    expect(shouldTriggerRemotePicker('hello~', true)).toBe(false)
    expect(shouldTriggerRemotePicker('~', true)).toBe(false)
  })
  it('does not trigger without a trailing ~', () => {
    expect(shouldTriggerRemotePicker('hello', false)).toBe(false)
    expect(shouldTriggerRemotePicker('~hello', false)).toBe(false)
    expect(shouldTriggerRemotePicker('a ~ b', false)).toBe(false)
    expect(shouldTriggerRemotePicker('', false)).toBe(false)
  })
})

describe('stripTrailingTilde', () => {
  it('removes exactly one trailing ~', () => {
    expect(stripTrailingTilde('hello~')).toBe('hello')
    expect(stripTrailingTilde('~')).toBe('')
  })
  it('leaves prompts without a trailing ~ unchanged', () => {
    expect(stripTrailingTilde('hello')).toBe('hello')
    expect(stripTrailingTilde('')).toBe('')
    expect(stripTrailingTilde('~hello')).toBe('~hello')
  })
  it('only strips one ~ from a run of trailing tildes', () => {
    expect(stripTrailingTilde('hello~~')).toBe('hello~')
  })
})
