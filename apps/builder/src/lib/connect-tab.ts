// Pipedream Connect se completa en otra pestaña. La pestaña se abre en el mismo clic, antes de pedir la URL:
// abierta después del await, el navegador la toma por popup y la bloquea.
export async function openConnectTab(connect: () => Promise<string>): Promise<void> {
  const tab = window.open('', '_blank')
  try {
    const url = await connect()
    if (url === 'about:blank') { tab?.close(); return }
    if (!tab) { window.open(url, '_blank', 'noopener'); return }
    tab.opener = null
    tab.location.href = url
  } catch (e) {
    tab?.close()
    throw e
  }
}
