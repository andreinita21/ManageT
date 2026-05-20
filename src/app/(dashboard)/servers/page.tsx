/**
 * /servers — legacy route. The Servers management UI now lives inside
 * Settings (under the "Servers" tab) so all configuration surfaces are
 * in one place. This page exists only to keep older bookmarks /
 * external links working; it 302-redirects to the new home. The
 * sibling /servers/[id] detail page is unchanged.
 */
import { redirect } from "next/navigation";

export default function ServersRedirect() {
  redirect("/settings?tab=servers");
}
