// Small stroke icons that inherit the current text colour, so they follow the theme.
const PATHS: Record<string, string> = {
  chat: 'M4 5h16v11H9l-5 4z',
  folder: 'M3 6h6l2 2h10v11H3z',
  'folder-open': 'M3 6h6l2 2h8v3M3 6v13h15l3-8H6l-3 8',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  'file-code': 'M6 3h8l4 4v14H6zM14 3v4h4M10 12l-2 2 2 2M14 12l2 2-2 2',
  'file-text': 'M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 15h6M9 18h4',
  'file-image': 'M6 3h8l4 4v14H6zM14 3v4h4M8 18l3-4 2 2 1.5-2 1.5 4z',
  flask: 'M9 3h6M10 3v6l-5 10h14l-5-10V3M7.5 14h9',
  users: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20c0-3.5 2.7-6 6-6s6 2.5 6 6M16 5a3 3 0 0 1 0 6M18 14c2 .6 3 2.8 3 6',
  user: 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4.4 3.6-7 8-7s8 2.6 8 7',
  bot: 'M5 8h14v11H5zM12 4v4M9 13h.01M15 13h.01M9 16h6',
  crown: 'M3 8l4 4 5-7 5 7 4-4-2 11H5z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5',
  puzzle: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1',
  pencil: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
  wrench: 'M14.5 6.5a4 4 0 0 0 5 5L12 19a2.1 2.1 0 0 1-3-3l7.5-7.5a4 4 0 0 1-2-2zM14.5 6.5L17 4',
  paperclip: 'M20 11l-8.5 8.5a5 5 0 0 1-7-7L13 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L14 7',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  spinner: 'M12 3a9 9 0 1 0 9 9',
  thought: 'M12 3a6 6 0 0 0-4 10.5V17h8v-3.5A6 6 0 0 0 12 3zM9 21h6',
  check: 'M5 12l5 5 9-10',
  x: 'M6 6l12 12M18 6L6 18',
  warn: 'M12 3l10 18H2zM12 10v5M12 18h.01',
  stop: 'M7 7h10v10H7z',
  play: 'M7 5l12 7-12 7z',
  eject: 'M5 15h14l-7-9zM5 19h14',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 3 2.5 15 0 18M12 3c-2.5 3-2.5 15 0 18',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  diff: 'M7 4v12M4 7l3-3 3 3M17 20V8M14 17l3 3 3-3',
  chevron: 'M6 9l6 6 6-6',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  flame: 'M12 3c1 4 6 6.5 6 11.5a6 6 0 0 1-12 0c0-3 1.5-4.5 2.5-6.5 1 1.5 1.5 2.5 2 4 1-3 1.5-5.5 1.5-9z',
  archive:'M3 4h18v4H3zM5 8v12h14V8M10 12h4',
}

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 14, className, spin }: { name: IconName | string; size?: number; className?: string; spin?: boolean }) {
  return (
    <svg
      className={'icon' + (spin ? ' spin' : '') + (className ? ' ' + className : '')}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name] ?? PATHS.file} />
    </svg>
  )
}
