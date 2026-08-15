# Organizing threads

The sidebar is organized around projects. Each project appears as its own row:
open one to see its pinned and active threads nested underneath, pinned first.
Projects with threads open expanded by default, and the sidebar remembers how
you left each project across reloads.

On web and desktop, drag a pinned thread to change its position. On mobile, open the thread's menu
and choose **Move up** or **Move down**. The order is stored by the server and appears on your
other connected devices.

If reordering is unavailable for one environment, update the Pivot server running in that
environment. Older servers can still pin and unpin threads, but do not understand synced ordering;
their pinned threads keep the default newest-first order below the ones you have arranged.

## Projects

The **Projects** section sits below the search and filter controls. Each row
shows the project's icon, name, and environment badge; the gear on the row
opens that project's omp capabilities (settings, skills, and rules scoped to
the project's `.omp` folder). The project filter above the list narrows which
projects — and their nested threads — appear.

Drafts you are composing stay at the top of the sidebar, above the projects.

## Snoozed

Threads you snooze leave their project row until their wake time and collect
on the global **Snoozed** shelf, between the projects and the settled dock.
The shelf is collapsed by default: the header shows the count, and expanding
it lists the snoozed threads soonest-to-wake first.

## Settled

Finished work collects in the **Settled** dock pinned to the bottom of the
sidebar, just above the status bar. Collapsed, the dock is a header with the
settled count; expanding it grows upward — the list above shrinks to make
room — and shows the most recent settled threads first. The dock caps the
rows it renders; choose **Show more** to page further back. A settled thread
you open stays visible in the dock so it is always one tap away from waking.

## Environment artwork

Dev and Nightly environments can identify themselves with artwork at the top of the sidebar and in
the send button. Choose **Artwork**, **Version pill**, or **None** in Settings under environment
identification. Artwork is recolored to match each built-in theme. Custom themes use the **Version
pill** fallback because their colors are not controlled by Pivot.

To generate a fresh title from the conversation, open a thread's context menu and choose
**Regenerate title**. While Pivot is generating it, the action reads **Regenerating…** and cannot
be selected again. The option is hidden when the connected environment needs a server update.
