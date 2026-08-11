import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { BookmarkNode } from '@shared/types'
import { Favicon } from '../theme/Favicon'
import { offshore, prettyHost } from './api'
import { IconChevron, IconClose, IconFolder } from './icons'

const OPEN_KEY = 'offshore.bmOpen'

function loadOpen(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}')
  } catch {
    return {}
  }
}

function saveOpen(open: Record<string, boolean>): void {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify(open))
  } catch {
    /* view state only */
  }
}

function childrenOf(nodes: BookmarkNode[], parentId: string | null): BookmarkNode[] {
  return nodes.filter((n) => n.parentId === parentId).sort((a, b) => a.index - b.index)
}

function BookmarkFavicon({ node }: { node: BookmarkNode }): React.JSX.Element {
  const letter = (prettyHost(node.url ?? '')[0] || '•').toUpperCase()
  return (
    <Favicon
      url={node.url}
      stored={node.favicon}
      className="bm-favicon"
      fallback={<span className="bm-glyph">{letter}</span>}
    />
  )
}

interface DropTarget {
  id: string
  pos: 'before' | 'after' | 'into'
}

interface BookmarksSectionProps {
  nodes: BookmarkNode[]
  renameId: string | null
  onRenameDone: () => void
}

/** Compact bookmark tree with folders — lives in the sidebar and the topbar panel. */
export function BookmarksSection({ nodes, renameId, onRenameDone }: BookmarksSectionProps): React.JSX.Element | null {
  const [open, setOpen] = useState<Record<string, boolean>>(loadOpen)
  const [dragId, setDragId] = useState<string | null>(null)
  const [target, setTarget] = useState<DropTarget | null>(null)
  const [renameText, setRenameText] = useState('')
  const springRef = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renameId) {
      const node = nodes.find((n) => n.id === renameId)
      setRenameText(node?.title ?? '')
      setTimeout(() => {
        renameInputRef.current?.focus()
        renameInputRef.current?.select()
      }, 30)
    }
  }, [renameId, nodes])

  // prune stale folder-open entries
  useEffect(() => {
    const ids = new Set(nodes.map((n) => n.id))
    const pruned = Object.fromEntries(Object.entries(open).filter(([id]) => ids.has(id)))
    if (Object.keys(pruned).length !== Object.keys(open).length) {
      setOpen(pruned)
      saveOpen(pruned)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes])

  const flat = useMemo(() => {
    const out: { node: BookmarkNode; depth: number }[] = []
    const walk = (parentId: string | null, depth: number): void => {
      for (const n of childrenOf(nodes, parentId)) {
        out.push({ node: n, depth })
        if (n.type === 'folder' && open[n.id]) walk(n.id, depth + 1)
      }
    }
    walk(null, 0)
    return out
  }, [nodes, open])

  if (!nodes.length) return null

  const toggleFolder = (id: string): void => {
    const next = { ...open, [id]: !open[id] }
    setOpen(next)
    saveOpen(next)
  }

  const clearSpring = (): void => {
    if (springRef.current) {
      clearTimeout(springRef.current.timer)
      springRef.current = null
    }
  }

  const commitRename = (): void => {
    if (renameId && renameText.trim()) {
      void offshore.bookmarks.update(renameId, { title: renameText.trim() })
    }
    onRenameDone()
  }

  const commitDrop = (): void => {
    if (!dragId || !target || dragId === target.id) {
      setDragId(null)
      setTarget(null)
      return
    }
    const over = nodes.find((n) => n.id === target.id)
    if (!over) {
      setDragId(null)
      setTarget(null)
      return
    }
    if (target.pos === 'into' && over.type === 'folder') {
      const count = childrenOf(nodes, over.id).filter((n) => n.id !== dragId).length
      void offshore.bookmarks.move(dragId, over.id, count)
    } else {
      const siblings = childrenOf(nodes, over.parentId).filter((n) => n.id !== dragId)
      const at = siblings.findIndex((n) => n.id === over.id)
      const index = target.pos === 'after' ? at + 1 : at
      void offshore.bookmarks.move(dragId, over.parentId, Math.max(0, index))
    }
    setDragId(null)
    setTarget(null)
  }

  return (
    <div className="bm-section no-drag">
      {flat.map(({ node, depth }) => {
        const renaming = node.id === renameId
        const isTarget = target?.id === node.id
        const classes = [
          'bm-row',
          node.type === 'folder' ? 'bm-folder' : '',
          dragId === node.id ? 'dragging' : '',
          isTarget && target?.pos === 'into' ? 'drop-into' : '',
          isTarget && target?.pos === 'before' ? 'drop-before' : '',
          isTarget && target?.pos === 'after' ? 'drop-after' : ''
        ]
          .filter(Boolean)
          .join(' ')
        return (
          <div
            key={node.id}
            className={classes}
            style={{ paddingLeft: 8 + depth * 14 }}
            draggable={!renaming}
            title={node.type === 'bookmark' ? `${node.title}\n${node.url}` : node.title}
            onDragStart={(e) => {
              setDragId(node.id)
              e.dataTransfer.setData('offshore/bookmark-id', node.id)
              e.dataTransfer.effectAllowed = 'move'
            }}
            onDragOver={(e) => {
              if (!dragId || dragId === node.id) return
              e.preventDefault()
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
              const y = (e.clientY - rect.top) / rect.height
              let pos: DropTarget['pos']
              if (node.type === 'folder') {
                pos = y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'into'
                if (pos === 'into' && !open[node.id] && springRef.current?.id !== node.id) {
                  clearSpring()
                  springRef.current = {
                    id: node.id,
                    timer: setTimeout(() => toggleFolder(node.id), 400)
                  }
                }
              } else {
                pos = y < 0.5 ? 'before' : 'after'
              }
              setTarget({ id: node.id, pos })
            }}
            onDragLeave={() => clearSpring()}
            onDragEnd={() => {
              clearSpring()
              setDragId(null)
              setTarget(null)
            }}
            onDrop={(e) => {
              e.preventDefault()
              clearSpring()
              commitDrop()
            }}
            onClick={() => {
              if (renaming) return
              if (node.type === 'folder') toggleFolder(node.id)
              else if (node.url) void offshore.tabs.create(node.url)
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              void offshore.menu.bookmarkContext(node.id)
            }}
          >
            {node.type === 'folder' ? (
              <>
                <span className={`bm-chevron ${open[node.id] ? 'open' : ''}`}>
                  <IconChevron size={11} />
                </span>
                <span className="bm-foldericon">
                  <IconFolder size={13} />
                </span>
              </>
            ) : (
              <BookmarkFavicon node={node} />
            )}
            {renaming ? (
              <input
                ref={renameInputRef}
                className="bm-rename"
                value={renameText}
                spellCheck={false}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setRenameText(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename()
                  if (e.key === 'Escape') onRenameDone()
                }}
              />
            ) : (
              <span className="bm-title">{node.title}</span>
            )}
            {node.type === 'folder' && !renaming && (
              <span className="bm-count">{childrenOf(nodes, node.id).length || ''}</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ---------------- bookmarks bar (horizontal layout) ----------------

/**
 * Chrome-style bar under the toolbar: top-level items, folders drop a menu.
 * Clearing a bookmark's name leaves the favicon alone on the bar — the same
 * trick Chromium allows, and the reason the bar can hold a couple of dozen.
 */
export function BookmarksBar({ nodes }: { nodes: BookmarkNode[] }): React.JSX.Element | null {
  const [openFolder, setOpenFolder] = useState<string | null>(null)
  const top = childrenOf(nodes, null)
  if (!top.length) return null

  const menuRows = (folderId: string): { node: BookmarkNode; depth: number }[] => {
    const out: { node: BookmarkNode; depth: number }[] = []
    const walk = (parentId: string, depth: number): void => {
      for (const n of childrenOf(nodes, parentId)) {
        out.push({ node: n, depth })
        if (n.type === 'folder') walk(n.id, depth + 1)
      }
    }
    walk(folderId, 0)
    return out
  }

  const openUrl = (url?: string): void => {
    setOpenFolder(null)
    if (url) void offshore.tabs.navigate(null, url)
  }

  return (
    <div className="bm-bar no-drag">
      {top.map((n) =>
        n.type === 'folder' ? (
          <div className="bm-bar-folder" key={n.id}>
            <button
              className={`bm-bar-item ${n.title.trim() ? '' : 'icon-only'} ${openFolder === n.id ? 'open' : ''}`}
              title={n.title}
              onClick={() => setOpenFolder(openFolder === n.id ? null : n.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                void offshore.menu.bookmarkContext(n.id)
              }}
            >
              <span className="bm-bar-foldericon">
                <IconFolder size={12} />
              </span>
              {n.title.trim() && <span className="bm-bar-title">{n.title}</span>}
            </button>
            {openFolder === n.id && (
              <div className="bm-bar-menu surface-card" onMouseLeave={() => setOpenFolder(null)}>
                {menuRows(n.id).map(({ node: c, depth }) =>
                  c.type === 'folder' ? (
                    <div className="bm-bar-menu-label" key={c.id} style={{ paddingLeft: 12 + depth * 14 }}>
                      <IconFolder size={11} />
                      <span>{c.title}</span>
                    </div>
                  ) : (
                    <button
                      key={c.id}
                      className="bm-bar-menu-item"
                      style={{ paddingLeft: 12 + depth * 14 }}
                      title={c.url}
                      onClick={() => openUrl(c.url)}
                    >
                      <BookmarkFavicon node={c} />
                      <span className="bm-bar-title">{c.title || prettyHost(c.url ?? '')}</span>
                    </button>
                  )
                )}
              </div>
            )}
          </div>
        ) : (
          <button
            key={n.id}
            className={`bm-bar-item ${n.title.trim() ? '' : 'icon-only'}`}
            title={n.title.trim() ? `${n.title}\n${n.url}` : n.url}
            onClick={() => openUrl(n.url)}
            onContextMenu={(e) => {
              e.preventDefault()
              void offshore.menu.bookmarkContext(n.id)
            }}
          >
            <BookmarkFavicon node={n} />
            {n.title.trim() && <span className="bm-bar-title">{n.title}</span>}
          </button>
        )
      )}
    </div>
  )
}

// ---------------- ⌘D popover ----------------

interface BookmarkEditProps {
  node: BookmarkNode
  nodes: BookmarkNode[]
  onClose: () => void
}

export function BookmarkEditPopover({ node, nodes, onClose }: BookmarkEditProps): React.JSX.Element {
  const [title, setTitle] = useState(node.title)
  const [newFolder, setNewFolder] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const folders = useMemo(() => {
    const out: { node: BookmarkNode; depth: number }[] = []
    const walk = (parentId: string | null, depth: number): void => {
      for (const n of childrenOf(nodes, parentId)) {
        if (n.type === 'folder') {
          out.push({ node: n, depth })
          walk(n.id, depth + 1)
        }
      }
    }
    walk(null, 0)
    return out
  }, [nodes])

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const commitTitle = (): void => {
    if (title.trim() && title.trim() !== node.title) {
      void offshore.bookmarks.update(node.id, { title: title.trim() })
    }
  }

  const done = (): void => {
    commitTitle()
    onClose()
  }

  return (
    <div className="bm-edit surface-card no-drag" onMouseDown={(e) => e.stopPropagation()}>
      <div className="bm-edit-head">
        <span>Bookmark saved</span>
        <button className="chrome-btn" onClick={done} title="Done">
          <IconClose size={12} />
        </button>
      </div>
      <input
        ref={inputRef}
        className="bm-edit-title"
        value={title}
        spellCheck={false}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') done()
          if (e.key === 'Escape') onClose()
        }}
      />
      {newFolder === null ? (
        <select
          className="bm-edit-folder"
          value={node.parentId ?? ''}
          onChange={(e) => {
            const v = e.target.value
            if (v === '__new__') {
              setNewFolder('')
              return
            }
            const parentId = v || null
            const count = childrenOf(nodes, parentId).filter((n) => n.id !== node.id).length
            void offshore.bookmarks.move(node.id, parentId, count)
            void offshore.bookmarks.setLastFolder(parentId)
          }}
        >
          <option value="">Bookmarks</option>
          {folders.map(({ node: f, depth }) => (
            <option key={f.id} value={f.id}>
              {`${'  '.repeat(depth)}${f.title}`}
            </option>
          ))}
          <option value="__new__">New folder…</option>
        </select>
      ) : (
        <input
          className="bm-edit-title"
          placeholder="Folder name"
          value={newFolder}
          autoFocus
          onChange={(e) => setNewFolder(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && newFolder.trim()) {
              void offshore.bookmarks.addFolder(newFolder.trim(), null).then((folder) => {
                if (folder) {
                  void offshore.bookmarks.move(node.id, folder.id, 0)
                  void offshore.bookmarks.setLastFolder(folder.id)
                }
                setNewFolder(null)
              })
            }
            if (e.key === 'Escape') setNewFolder(null)
          }}
        />
      )}
      <div className="bm-edit-actions">
        <button
          className="bm-edit-remove"
          onClick={() => {
            void offshore.bookmarks.remove(node.id)
            onClose()
          }}
        >
          Remove
        </button>
        <button className="bm-edit-done" onClick={done}>
          Done
        </button>
      </div>
    </div>
  )
}
