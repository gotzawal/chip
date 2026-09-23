import sys
exec(open('wasmcalls.py').read().split('# decode code section')[0].replace("sys.argv[1]","sys.argv[1]"))
# collect imported globals with names
p=8; gimp=[]
while p<len(data):
    sid=data[p];p+=1
    sz,p=leb(data,p); end=p+sz
    if sid==2:
        n,q=leb(data,p)
        for i in range(n):
            ml,q=leb(data,q); mod=data[q:q+ml].decode(); q+=ml
            fl,q=leb(data,q); fld=data[q:q+fl].decode(); q+=fl
            kind=data[q]; q+=1
            if kind==0: _,q=leb(data,q)
            elif kind==1:
                q+=1; fl2=data[q]; q+=1; _,q=leb(data,q)
                if fl2&1: _,q=leb(data,q)
            elif kind==2:
                fl2=data[q]; q+=1; _,q=leb(data,q)
                if fl2&1: _,q=leb(data,q)
            elif kind==3: q+=2; gimp.append(mod+':'+fld)
            elif kind==4: q+=1; _,q=leb(data,q)
    p=end
import re
src=open('wasmcalls.py').read()
body=src.split('# decode code section')[1]
body=body.replace("elif op in (0x20,0x21,0x22,0x23,0x24,0x25,0x26): _,p=leb(data,p)",
 "elif op==0x23:\n            g,p=leb(data,p); out.append(('global.get',g))\n        elif op in (0x20,0x21,0x22,0x24,0x25,0x26): _,p=leb(data,p)")
body=body.replace("nm=exports.get(t,'?') if t is not None else ''","nm=(exports.get(t,'?') if k=='call' else (gimp[t] if k=='global.get' and t<len(gimp) else '')) if t is not None else ''")
exec(body)
