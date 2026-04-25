import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app";
import "./styles.css";

function Router() {
  if (!isKnownRoute(window.location.pathname)) {
    return <NotFound />;
  }

  return <App />;
}

function isKnownRoute(pathname: string) {
  return pathname === "/" || /^\/s\/[23456789abcdefghjkmnpqrstuvwxyz]{3}-[23456789abcdefghjkmnpqrstuvwxyz]{3}$/.test(pathname);
}

function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-stone-950 px-6 text-stone-100">
      <section className="w-full max-w-md rounded-3xl border border-white/10 bg-black/30 p-6">
        <p className="text-xs uppercase tracking-[0.32em] text-amber-400">ttys</p>
        <h1 className="mt-4 text-2xl font-medium text-stone-100">Page not found</h1>
        <p className="mt-3 text-sm leading-6 text-stone-400">
          This link does not match an active ttys route.
        </p>
        <a
          href="/"
          className="mt-6 inline-flex rounded-xl border border-white/10 bg-white px-4 py-2 text-sm font-medium text-stone-950 transition hover:bg-stone-200"
        >
          Go home
        </a>
      </section>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Router />
  </React.StrictMode>,
);
