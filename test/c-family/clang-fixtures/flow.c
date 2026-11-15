#define APPLY(fn, value) fn(value)
int target(int value) { return value; }
int through_macro(int value) { return APPLY(target, value); }
int through_pointer(int (*function)(int), int value) { return function(value); }
int flow(int count) {
    int result = 0;
    for(int i = 0; i < count; ++i) result += target(i);
    while(result < 4) ++result;
    do { --result; } while(result > 8);
    if(result > 0) return through_pointer(target, result);
    return through_macro(result);
}
struct S { unsigned :3, value:2; int tail; };
struct S record = {.tail=8, .value=1};
int array[5] = {[2]=7,[4]=9};
enum E { ZERO, FIVE=5, SIX };
int read_enum(void) { return SIX; }
int read_switch(int value) {
    switch(value) { case 1: case 2: return target(value); default: return 0; }
}
int generic_selected(int value) { return _Generic(value, int: __extension__ target(value), default: read_enum()); }
