from PIL import Image, ImageDraw, ImageFilter
import random
random.seed(3)
def base():
    W,H=1600,1200
    im=Image.new('RGB',(W,H),(222,218,208)); d=ImageDraw.Draw(im)
    for i in range(6000):
        x,y=random.randrange(W),random.randrange(H); c=random.randint(200,232); d.point((x,y),(c,c-3,c-10))
    # floor
    d.polygon([(0,930),(W,880),(W,H),(0,H)],fill=(150,140,125))
    for x in range(-400,W+400,160): d.line([(x,H),(x+120,890)],fill=(130,120,108),width=3)
    # door frame + door
    d.rectangle([520,180,1060,930],fill=(120,85,55)); d.rectangle([550,210,1030,930],fill=(176,132,90))
    for y in (300,620): d.rectangle([600,y,980,y+250],outline=(150,110,72),width=8)
    d.ellipse([960,560,1000,600],fill=(200,190,160)); d.rectangle([985,570,1020,585],fill=(200,190,160))
    # hinge
    d.rectangle([548,300,575,380],fill=(160,160,155)); d.rectangle([548,700,575,780],fill=(160,160,155))
    # skirting
    d.rectangle([0,900,520,930],fill=(240,240,236)); d.rectangle([1060,890,W,920],fill=(240,240,236))
    # light switch
    d.rectangle([1200,480,1290,580],fill=(245,245,240),outline=(180,180,175),width=3)
    return im
a=base(); d=ImageDraw.Draw(a)
pts=[(1150,250),(1180,330),(1170,400),(1220,470),(1205,540),(1250,640),(1240,720),(1290,800)]
d.line(pts,fill=(70,62,55),width=5)
d.line([(1220,470),(1300,500),(1340,560)],fill=(80,70,60),width=3)
d.rectangle([548,700,575,780],fill=(130,95,60)); d.polygon([(560,690),(600,720),(590,800),(552,790)],fill=(160,160,155))  # loose hinge
a.filter(ImageFilter.GaussianBlur(0.8)).save('before.jpg',quality=88)
b=base(); b.filter(ImageFilter.GaussianBlur(0.8)).save('after.jpg',quality=88)
