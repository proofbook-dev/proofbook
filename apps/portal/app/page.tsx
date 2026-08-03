import Link from "next/link";

export default function Home() {
  return (
    <main className="wrap" style={{ paddingTop: 80, maxWidth: 560 }}>
      <h1>Proofbook portal</h1>
      <p className="muted">
        Evidence recipients arrive here through a share link sent by the
        company being reviewed; there is nothing to browse without one.
      </p>
      <p>
        <Link className="btn btn-dark" href="/login">
          Customer sign in
        </Link>
      </p>
    </main>
  );
}
