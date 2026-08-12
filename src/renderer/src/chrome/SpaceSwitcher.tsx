import React, { useEffect, useRef, useState } from 'react'
import type { SpaceInfo } from '@shared/types'
import { offshore } from './api'
import { IconPlus } from './icons'

interface SpaceSwitcherProps {
  spaces: SpaceInfo[]
  activeSpaceId: string
  renameId: string | null
  onRenameDone: () => void
  accentFor: (space: SpaceInfo) => string
  compact?: boolean
}

/**
 * Arc-style space chips. Invisible until a second space exists (Helium rule:
 * zero chrome for features you aren't using) — the first extra space comes from
 * ⌘⌥N, the palette, or a tab's "Move to Space" menu.
 */
export function SpaceSwitcher({
  spaces,
  activeSpaceId,
  renameId,
  onRenameDone,
  accentFor,
  compact
}: SpaceSwitcherProps): React.JSX.Element | null {
  const [renameText, setRenameText] = useState('')
  const springRef = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renameId) {
      const space = spaces.find((s) => s.id === renameId)
      setRenameText(space?.name ?? '')
      // focus after the input mounts
      setTimeout(() => {
        renameInputRef.current?.focus()
        renameInputRef.current?.select()
      }, 30)
    }
  }, [renameId, spaces])

  if (spaces.length < 2 && !renameId) return null

  const commitRename = (): void => {
    if (renameId && renameText.trim()) void offshore.spaces.rename(renameId, renameText.trim())
    onRenameDone()
  }

  const clearSpring = (): void => {
    if (springRef.current) {
      clearTimeout(springRef.current.timer)
      springRef.current = null
    }
  }

  return (
    <div className={`space-switcher no-drag ${compact ? 'compact' : ''}`}>
      {spaces.map((space) => {
        const active = space.id === activeSpaceId
        const renaming = space.id === renameId
        const color = accentFor(space)
        if (renaming) {
          return (
            <input
              key={space.id}
              ref={renameInputRef}
              className="space-rename"
              value={renameText}
              spellCheck={false}
              onChange={(e) => setRenameText(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename()
                if (e.key === 'Escape') onRenameDone()
              }}
            />
          )
        }
        return (
          <button
            key={space.id}
            className={`space-chip ${active ? 'active' : ''} ${space.profile === 'separate' ? 'separate' : ''}`}
            style={{ '--space-color': color } as React.CSSProperties}
            title={`${space.name}${space.profile === 'separate' ? ' — separate logins' : ''}`}
            onClick={() => {
              if (!active) void offshore.spaces.activate(space.id)
            }}
            onDoubleClick={() => {
              if (active) {
                window.dispatchEvent(new CustomEvent('offshore:space-rename', { detail: space.id }))
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              void offshore.menu.spaceContext(space.id)
            }}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('offshore/tab-id')) {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                if (!active && springRef.current?.id !== space.id) {
                  clearSpring()
                  springRef.current = {
                    id: space.id,
                    timer: setTimeout(() => void offshore.spaces.activate(space.id), 350)
                  }
                }
              }
            }}
            onDragLeave={clearSpring}
            onDrop={(e) => {
              clearSpring()
              const tabId = Number(e.dataTransfer.getData('offshore/tab-id'))
              if (tabId) {
                e.preventDefault()
                void offshore.spaces.moveTab(tabId, space.id)
              }
            }}
          >
            <span className="space-dot" />
            {active && <span className="space-name">{space.name}</span>}
          </button>
        )
      })}
      <button
        className="space-add"
        title="New space (⌘⌥N)"
        onClick={() => {
          void offshore.spaces.create().then((id) => {
            if (id) window.dispatchEvent(new CustomEvent('offshore:space-rename', { detail: id }))
          })
        }}
      >
        <IconPlus size={12} />
      </button>
    </div>
  )
}
