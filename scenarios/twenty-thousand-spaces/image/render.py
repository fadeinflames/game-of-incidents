"""Post rendering: every line of a post is cleaned and escaped before it goes into a page."""
import html
import re

# Leading and trailing whitespace of a line, including the zero-width non-joiners that some editors leave behind.
_TRIM = re.compile(r"^[\s‌]+|[\s‌]+$")


def clean_line(line):
    return _TRIM.sub("", line)


def render_post(body):
    return "<br>".join(html.escape(clean_line(line)) for line in body.split("\n"))
