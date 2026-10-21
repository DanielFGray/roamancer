{ pkgs, ... }:
let
  # One file server serves every static site. Each release is a folder that
  # is never changed after it is written, at /srv/www/<site>/<release>. The
  # Traefik route for a host names the folder in X-Site-Release, so a
  # promotion or a rollback changes only the route, never this file or the
  # folders.
  releasesDir = "/srv/www";

  caddyfile = pkgs.writeText "Caddyfile" ''
    {
      admin off
      auto_https off
      log {
        level ERROR
      }
    }

    # HTML pages name the hashed assets of their release, so a browser
    # must ask again for the page to see a new release. Both the normal
    # chain and the error chain import this.
    (html-no-cache) {
      header {
        match {
          header Content-Type text/html*
        }
        Cache-Control no-cache
      }
    }

    # Traefik passes the client's host name through, so the site matches
    # any host. bind keeps the listener on loopback, where Traefik is the
    # client. Every static-site route sets both X-Site-Release and
    # X-Site-Fallback; Traefik replaces a client's value of a header it sets,
    # and an empty X-Site-Fallback removes it, which turns the fallback off.
    :8080 {
      bind 127.0.0.1

      @norelease not header X-Site-Release *
      respond @norelease 404

      root * ${releasesDir}/{header.X-Site-Release}

      # A browser that asks for a page with no file gets the site's
      # fallback page, when its route names one. A missing asset still
      # gets 404, because a script or image request does not accept HTML.
      @fallback {
        header X-Site-Fallback *
        header Accept *text/html*
        not file
        file {header.X-Site-Fallback}
      }
      rewrite @fallback {header.X-Site-Fallback}

      import html-no-cache

      file_server {
        precompressed br gzip
      }

      handle_errors 404 {
        import html-no-cache
        rewrite * /404.html
        file_server
      }
    }
  '';
in
{
  services.caddy = {
    enable = true;
    configFile = caddyfile;

    # The admin API is off, so a reload has nothing to talk to. A config
    # change restarts the service instead, and the config holds no state
    # that a restart could lose.
    enableReload = false;
  };
}
