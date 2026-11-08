/* Not C: parse error recovery leaves the body `{ ...; return s; }` at file level. */
inline stream &set_level(stream &s, int l)
{
  (s.buf())->set_level(l);
  return s;
}
