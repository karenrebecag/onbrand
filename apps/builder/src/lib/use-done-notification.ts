import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'

// HE de Lovable (app-lazy-shared deob l.23589-23625): el permiso se lee con useSyncExternalStore y quien lo pide avisa a
// los suscriptores (R4), porque el navegador no emite evento cuando cambia Notification.permission.
const listeners = new Set<() => void>()
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }
const supported = (): boolean => typeof window !== 'undefined' && 'Notification' in window
const readPermission = (): NotificationPermission => supported() ? Notification.permission : 'default'

/** Solo con permiso y con la pestaña oculta: mirando el builder ya está el aviso del lienzo (showNotification, l.23620). */
export const shouldNotify = (permission: NotificationPermission, hidden: boolean): boolean => permission === 'granted' && hidden

/** Textos de P4/k4 (l.23708-23735): la primera generación anuncia la página, un follow-up los cambios. */
export function doneMessage(first: boolean, title: string | undefined): { title: string; body: string } {
  return { title: title || 'Terminó de trabajar', body: first ? 'Tu página está lista.' : 'Tus cambios están listos.' }
}

export interface DoneNotification {
  supported: boolean
  permission: NotificationPermission
  /** MDN Notification.requestPermission: se llama desde un gesto de la persona (el botón del composer). */
  request: () => Promise<boolean>
}

/** Avisa con una notificación del sistema cuando un turno termina con versión, como generationComplete en Lovable. */
export function useDoneNotification(busy: boolean, saved: boolean, first: boolean, title: string | undefined): DoneNotification {
  const permission = useSyncExternalStore(subscribe, readPermission, () => 'default' as NotificationPermission)
  const wasBusy = useRef(busy)
  useEffect(() => {
    if (wasBusy.current && !busy && saved && shouldNotify(readPermission(), document.hidden)) {
      const msg = doneMessage(first, title)
      try {
        const n = new Notification(msg.title, { body: msg.body, tag: 'wt-done', silent: false })
        n.onclick = () => { window.focus(); n.close() }
        // Una notificación del sistema no está en el DOM: el arnés (A4, fila 25) lee este atributo para saber que salió.
        document.documentElement.setAttribute('data-wt-notified', msg.body)
      } catch {
        // Algunos navegadores solo crean notificaciones desde un service worker: el aviso del lienzo sigue estando.
      }
    }
    wasBusy.current = busy
  }, [busy, saved, first, title])
  const request = useCallback(async () => {
    if (!supported()) return false
    const result = await Notification.requestPermission()
    listeners.forEach((fn) => fn())
    return result === 'granted'
  }, [])
  return { supported: supported(), permission, request }
}
