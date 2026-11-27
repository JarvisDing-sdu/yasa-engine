static unsigned slot(void) { return 0; }
static unsigned mask(void) { return 1; }
void set_bits(unsigned *words) {
    words[slot()] |= mask();
}
