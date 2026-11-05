import { useState } from 'react'
import * as Menu from '@radix-ui/react-dropdown-menu'
import { LogOutIcon, MenuIcon, UserIcon } from 'lucide-react'
import { Button } from '@/components/arc/button/button'
import composerStyles from '@/components/arc/blocks/ai-composer/ai-composer.module.css'
import type { SessionMenu } from '@/lib/session-provider'
import styles from './builder.module.css'

/** Menú de la barra cuando el provider de la distro trae dueño o cierre de sesión (ADR 0017; sessionMenuOf). Con el
 * provider local no se monta y la barra deja el botón apagado como antes. El dueño es el que el provider dice; el builder
 * no lee el token. */
export function SessionMenuButton({ menu }: { menu: SessionMenu }) {
  const [error, setError] = useState('')
  const who = menu.user ? menu.user.label ?? menu.user.id : null
  return (
    <Menu.Root modal={false} onOpenChange={() => setError('')}>
      <Menu.Trigger asChild>
        <Button variant="ghost" size="sm" className={`${styles.roundIcon} ${styles.menuIcon}`} aria-label="Menú"><MenuIcon size={18} /></Button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className={composerStyles.menu} side="bottom" align="start" sideOffset={6} collisionPadding={12} loop aria-label="Sesión">
          {who && <Menu.Label className={styles.sessionOwner}><UserIcon size={14} aria-hidden="true" /><span>{who}</span></Menu.Label>}
          {who && menu.signOut && <Menu.Separator className={composerStyles.menuSeparator} />}
          {menu.signOut && (
            <Menu.Item className={composerStyles.menuItem} onSelect={(e) => { e.preventDefault(); menu.signOut!().catch(() => setError('No se pudo cerrar la sesión. Vuelve a intentarlo.')) }}>
              <LogOutIcon size={15} aria-hidden="true" />Cerrar sesión
            </Menu.Item>
          )}
          {error && <p className={styles.sessionError} role="alert">{error}</p>}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  )
}
