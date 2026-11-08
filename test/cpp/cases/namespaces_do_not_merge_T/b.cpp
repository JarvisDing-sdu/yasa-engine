namespace SeparatedTaintedB {
void sink(char *s) { (void)s; }
void bad() { sink((char *)"safe"); }
}
