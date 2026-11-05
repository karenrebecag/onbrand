import * as Menu from '@radix-ui/react-dropdown-menu'
import { ChevronDownIcon, HistoryIcon, RefreshCwIcon } from 'lucide-react'
import composerStyles from '@/components/arc/blocks/ai-composer/ai-composer.module.css'
import { dsChangeOf, type Version } from '@/lib/run-client'
import styles from './builder.module.css'

const when = (at: number | null) =>
  at === null ? '' : new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

interface VersionsMenuProps {
  versions: Version[]
  busy: boolean
  onRestore: (version: Version) => void
  /** Ausente donde no hay transport que monte el DS. */
  onUpdateDs?: () => void
  /** C3: pin corto del DS nuevo cuando el registry publica uno distinto al del chat; null deja el ítem como siempre. */
  dsUpdate?: string | null
}

/** Como el "Latest" de v0, pero elegir una versión dice "Restore": en v0 un clic restaura sin avisar y es fácil
 * hacerlo creyendo que solo se previsualiza. */
export function VersionsMenu({ versions, busy, onRestore, onUpdateDs, dsUpdate }: VersionsMenuProps) {
  if (!versions.length) return null
  const newestFirst = [...versions].reverse()
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger asChild>
        <button type="button" className={styles.versionsTrigger} aria-label={`Versions, ${versions.length}`}>
          <HistoryIcon size={14} aria-hidden="true" />
          {versions.length === 1 ? '1 versión' : `${versions.length} versiones`}
          <ChevronDownIcon size={14} aria-hidden="true" />
        </button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className={`${composerStyles.menu} ${styles.versionsMenu}`} side="bottom" align="start" sideOffset={6} collisionPadding={12} loop>
          {newestFirst.map((v) => {
            const ds = dsChangeOf(v)
            return (
            <Menu.Item
              key={v.messageId}
              className={`${composerStyles.menuItem} ${styles.versionItem}`}
              disabled={v.head || busy}
              aria-label={v.head ? `${v.title}, versión actual` : `Restaurar ${v.title}`}
              onSelect={() => onRestore(v)}
            >
              <span className={styles.versionText}>
                <span className={styles.versionTitle}>{v.title}</span>
                <span className={styles.versionDate}>{ds ? `DS ${ds} · ${when(v.at)}` : when(v.at)}</span>
              </span>
              <span className={styles.menuMeta}>{v.head ? 'Actual' : 'Restaurar'}</span>
            </Menu.Item>
            )
          })}
          {onUpdateDs && (
            <>
              <Menu.Separator className={composerStyles.menuSeparator} />
              {/* El chat queda fijado a su DS (reproducibilidad); esto lo mueve al último publicado en una versión propia. */}
              <Menu.Item className={`${composerStyles.menuItem} ${dsUpdate ? styles.dsUpdateItem : ''}`} disabled={busy} onSelect={onUpdateDs}>
                <span className={composerStyles.menuIcon}><RefreshCwIcon aria-hidden="true" /></span>
                Actualizar DS
                {dsUpdate && <span className={styles.menuMeta}>{dsUpdate} disponible</span>}
              </Menu.Item>
            </>
          )}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  )
}
