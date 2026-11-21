import { Injectable, inject } from '@angular/core';
import { NavigationEnd, Router, type ActivatedRouteSnapshot } from '@angular/router';
import { filter } from 'rxjs';
import { ApiService } from './api.service';

/**
 * Reports each backoffice screen a member opens to the activity log (the server can't see SPA navigation). Only the
 * pathname is sent, never query strings or fragments (the join page's fragment holds a one-time token).
 */
@Injectable({ providedIn: 'root' })
export class ActivityTracker {
  private api = inject(ApiService);
  private router = inject(Router);
  private started = false;
  start() {
    if (this.started) return;
    this.started = true;
    this.router.events.pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd)).subscribe((e) => {
      let r: ActivatedRouteSnapshot | null = this.router.routerState.snapshot.root;
      while (r?.firstChild) r = r.firstChild;
      const feature = (r?.data?.['feature'] as string | undefined) ?? null;
      // Only guarded screens; No access reports itself as "page denied".
      if (!this.api.token() || !feature) return;
      this.api.beacon({ kind: 'page_view', path: e.urlAfterRedirects.split(/[?#]/)[0], feature }).subscribe({ error: () => undefined });
    });
  }
}
