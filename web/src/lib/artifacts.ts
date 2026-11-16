const ARTIFACT_URL = /^https:\/\/claude\.ai\/(?:code\/)?artifact\/([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/

/** The artifact id in a claude.ai artifact URL (either form), or null for any other URL. */
export const artifactIdOf = (url: string) => ARTIFACT_URL.exec(url)?.[1] ?? null

/**
 * An artifact's local URL: its newest local copy, served by the studio server, or a redirect to claude.ai when there is none.
 * The server is the one serving the cockpit (STUDIO_PORT), so it is the page's own origin; localhost:4000 outside a page.
 */
export const localArtifactUrl = (id: string, version?: number) =>
  (typeof location === 'undefined' ? 'http://localhost:4000' : location.origin) + '/_env/artifact/' + id + '/' + (version ? 'v' + version + '/' : '')

/** A plain left click, which a page may handle itself; modified and middle clicks open a tab, as links do. */
export const isPlainClick = (event: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey

/** An element picked in an artifact with the cockpit's pick tool (PICKER_SCRIPT in studio-server.js). */
export type ArtifactPick = { from: string; selector: string; text: string; heading: string | null; tag: string }

/** A pick as the chat tells Claude about it. */
export const describePick = (pick: ArtifactPick) =>
  'In ' + pick.from + ', the user picked a <' + pick.tag + '> at `' + pick.selector + '`' + (pick.heading ? ' under the heading “' + pick.heading + '”' : '') + (pick.text ? ', reading “' + pick.text + '”' : '') + '.'

/** Sent after picks, so a question about a picked element is answered beside it rather than in a new version. */
export const PICK_NOTE_HINT =
  'If the message asks a question about a picked element (rather than asking for a change), answer it beside the element in the cockpit\'s preview: ' +
  "node \"$STUDIO_DIR/scripts/lib/artifacts.js\" note <artifact url> '<selector>' '<answer, plain text>' " +
  '(it shows on the version previewed, and is never published), then reply in the chat with one line saying the answer is on the page.'

/** A pick's short name on its chip. */
export const pickLabel = (pick: ArtifactPick) => (pick.text || pick.heading || pick.selector).slice(0, 40)

/** Asks the cockpit's chat to take the keyboard back (after a click or a pick in an artifact). */
export const FOCUS_CHAT_EVENT = 'studio-focus-chat'
export const focusChat = () => window.dispatchEvent(new Event(FOCUS_CHAT_EVENT))
