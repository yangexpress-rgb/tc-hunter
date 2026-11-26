import { hasFreshStepUp, listInvitations, listPeople, type InvitationStatus } from "@tc-hunter/db";
import { t } from "@tc-hunter/domain";
import { TopBar } from "@/components/TopBar";
import { flashOf, type PageProps } from "@/lib/profile";
import { app, requireSession } from "@/lib/server";
import { ConfirmCard, NeedsConfirm, SettingsHeader } from "../shared";
import { accessAction, adminRoleAction, revokeAction, twoStepResetAction } from "./actions";
import { InviteForm, RemakeForm, ResetLinkForm } from "./InviteForms";

export const dynamic = "force-dynamic";

const day = (d: Date | string) => new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(d));
const STATUS: Record<InvitationStatus, string> = { waiting: "Waiting", accepted: "Accepted", expired: "Expired", revoked: "Revoked" };

/**
 * Settings › People (Yong, 2026-11-25): only the person who runs TC Hunter sees it.
 * Everyone with an account, invitations, and turning access off or on. Accounts only,
 * never anyone's data; every action is checked again in the database.
 */
export default async function PeoplePage(props: PageProps) {
  const session = await requireSession();
  const { pool, cfg } = app();
  const { saved, error, params } = await flashOf(props);
  if (!session.isAdmin) {
    return (
      <>
        <TopBar signedIn />
        <p className="error">{t("people.not_admin")}</p>
      </>
    );
  }
  const who = { userAccountId: session.userAccountId, applicantId: session.applicantId };
  const [people, invitations] = await Promise.all([listPeople(pool, who), listInvitations(pool, who)]);
  const fresh = hasFreshStepUp(session, cfg);
  const adminCount = people.filter((p) => p.isAdmin && p.accessOn).length;
  return (
    <>
      <SettingsHeader title="People" intro="Who can use TC Hunter. You manage their accounts here; their information stays theirs." params={params} saved={saved} error={error} />

      <section className="card" id="invite">
        <h2>Invite someone</h2>
        <p className="muted">TC Hunter makes a code for that email. You send it to them yourself.</p>
        <InviteForm />
      </section>

      <section className="card" id="people">
        <h2>People</h2>
        {!fresh ? <NeedsConfirm what="Changing someone's access, password, two-step sign-in or admin role" /> : null}
        <table className="report">
          <thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Joined</th><th scope="col">Two-step sign-in</th><th scope="col">Status</th><th scope="col"></th></tr></thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.userAccountId}>
                <th scope="row">{p.preferredName || "(no name)"}{p.isAdmin ? <> <span className="pill">Admin</span></> : null}{p.isYou ? <span className="muted"> (you)</span> : null}</th>
                <td>{p.email}</td>
                <td>{day(p.joinedAt)}</td>
                <td>{p.twoStep ? "On" : p.hasPasskey ? "Passkey" : "Off"}</td>
                <td className={p.accessOn ? undefined : "error"}>{p.accessOn ? "Active" : "Access off"}</td>
                <td>
                  {fresh ? (
                    <div className="person-actions">
                      {!p.isYou ? (
                        <form action={accessAction}>
                          <input type="hidden" name="id" value={p.userAccountId} />
                          <input type="hidden" name="on" value={p.accessOn ? "0" : "1"} />
                          <button className={p.accessOn ? "link danger" : "link"}>{p.accessOn ? "Turn access off" : "Turn access on"}</button>
                        </form>
                      ) : null}
                      {!p.isYou ? <ResetLinkForm id={p.userAccountId} /> : null}
                      {!p.isYou && (p.twoStep || p.hasPasskey) ? (
                        <form action={twoStepResetAction}>
                          <input type="hidden" name="id" value={p.userAccountId} />
                          <button className="link">{p.twoStep ? "Reset two-step sign-in" : "Remove their passkeys"}</button>
                        </form>
                      ) : null}
                      {p.accessOn && (!p.isYou || adminCount > 1) ? (
                        <form action={adminRoleAction}>
                          <input type="hidden" name="id" value={p.userAccountId} />
                          <input type="hidden" name="on" value={p.isAdmin ? "0" : "1"} />
                          <button className="link">{p.isAdmin ? (p.isYou ? "Stop being an admin" : "Remove admin") : "Make admin"}</button>
                        </form>
                      ) : null}
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">Turning access off signs them out everywhere at once and stops them signing in. Their information is kept, and turning access back on lets them sign in as before.</p>
        <p className="muted small">A password reset link lets someone who lost their password set a new one. Resetting two-step sign-in clears their authenticator app and recovery codes (or removes their passkeys), so they set it up again next time they sign in. Admins can see this page and manage people; there is always at least one.</p>
      </section>

      <section className="card" id="invitations">
        <h2>Invitations</h2>
        {invitations.length ? (
          <table className="report">
            <thead><tr><th scope="col">Email</th><th scope="col">Invited by</th><th scope="col">Made</th><th scope="col">Works until</th><th scope="col">Status</th><th scope="col"></th></tr></thead>
            <tbody>
              {invitations.map((i) => (
                <tr key={i.id}>
                  <th scope="row">{i.email}</th>
                  <td>{i.invitedBy ?? "someone no longer here"}</td>
                  <td>{day(i.createdAt)}</td>
                  <td>{day(i.expiresAt)}</td>
                  <td>{STATUS[i.status]}</td>
                  <td>
                    {i.status === "waiting" ? (
                      <div className="inline-actions">
                        <RemakeForm id={i.id} />
                        <form action={revokeAction}>
                          <input type="hidden" name="id" value={i.id} />
                          <button className="link danger">Revoke</button>
                        </form>
                      </div>
                    ) : i.status === "expired" ? <span className="muted">Invite them again above for a new code.</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="muted">No invitations yet.</p>}
      </section>

      <ConfirmCard session={session} back="/settings/people" why="Changing someone's access, password, two-step sign-in or admin role needs a fresh check that it's you." />
    </>
  );
}
