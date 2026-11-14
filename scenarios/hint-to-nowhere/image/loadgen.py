#!/usr/bin/env python3
"""loadgen: the users of the board. Each of them opens the profile, the task list or the feed, about three pages a second."""
import random
import time
import urllib.error
import urllib.request

API = "http://127.0.0.1:8080"
USERS = [base + n for base in (1000, 2000, 3000) for n in range(1, 101)]
PAGES = ["", "/tasks", "/feed"]


def main():
    rnd = random.Random()
    while True:
        url = f"{API}/users/{rnd.choice(USERS)}{rnd.choice(PAGES)}"
        try:
            urllib.request.urlopen(url, timeout=5).read()
        except Exception:  # noqa: BLE001  an error page is the user's problem; the next user comes anyway
            pass
        time.sleep(0.33)


if __name__ == "__main__":
    main()
