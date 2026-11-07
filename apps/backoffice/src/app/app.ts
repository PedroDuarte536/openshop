import { Component, inject } from '@angular/core';
import { Router, RouterOutlet, RouterLink } from '@angular/router';
import { ApiService } from './api.service';

@Component({
  imports: [RouterOutlet, RouterLink],
  selector: 'app-root',
  styleUrl: './app.css',
  templateUrl: './app.html',
})
export class App {
  protected api = inject(ApiService);
  private router = inject(Router);
  protected logout() { this.api.logout(); this.router.navigate(['/login']); }
}
